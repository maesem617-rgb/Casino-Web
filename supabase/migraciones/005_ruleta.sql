-- =====================================================================
-- 005_ruleta.sql
-- Juego de Ruleta europea (0 a 36): una sola función RPC que gira la rueda.
--
-- Idea general:
--   * El navegador solo envía la lista de apuestas (tipo, valor, cantidad).
--   * El número se saca AQUÍ, en el servidor, con gen_random_bytes
--     (fuente aleatoria criptográfica de pgcrypto).
--   * Partida, movimientos y saldo se registran en la misma transacción:
--     o se guarda todo, o no se guarda nada.
--   * Se pueden poner varias apuestas en un mismo giro (de 1 a 20).
--     En la tabla partida se guarda UNA fila por giro con los totales.
--
-- Tipos de apuesta (el premio ya incluye lo apostado):
--   pleno    número 0..36                      apuesta x 36
--   color    'ROJO' / 'NEGRO'                  apuesta x 2
--   paridad  'PAR' / 'IMPAR'                   apuesta x 2
--   mitad    'BAJA' (1-18) / 'ALTA' (19-36)    apuesta x 2
--   docena   1 / 2 / 3 (1-12, 13-24, 25-36)    apuesta x 3
--   columna  1 / 2 / 3 (1,4..34 / 2,5..35 / 3,6..36)  apuesta x 3
-- Si sale el 0, solo gana un pleno al 0: el 0 no es rojo ni negro, ni par
-- ni impar, ni de ninguna mitad, docena o columna.
--
-- No crea tablas nuevas. Usa: usuario, juego, partida, movimiento_token.
-- Todo el archivo corre en una transacción: si algo falla, no se aplica nada.
-- =====================================================================

begin;

-- En Supabase ya viene instalada en "extensions"; esto no hace nada si existe.
create extension if not exists pgcrypto with schema extensions;


-- ---------------------------------------------------------------------
-- ruleta_girar: valida las apuestas, cobra el total, gira y paga.
--   p_apuestas: arreglo JSON, por ejemplo
--   [{"tipo":"color","valor":"ROJO","cantidad":50},
--    {"tipo":"pleno","valor":17,"cantidad":10}]
-- ---------------------------------------------------------------------
create or replace function public.ruleta_girar(p_apuestas jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    -- Números rojos de la ruleta europea. Del 1 al 36, el resto son negros.
    c_rojos constant integer[] := array[1, 3, 5, 7, 9, 12, 14, 16, 18,
                                        19, 21, 23, 25, 27, 30, 32, 34, 36];
    c_max_apuestas constant integer := 20;

    v_uid          uuid := auth.uid();
    v_apuesta      jsonb;          -- una apuesta tal como llegó
    v_tipo         text;
    v_valor_txt    text;
    v_valor_num    integer;
    v_valor        jsonb;          -- valor ya normalizado (número o texto)
    v_cantidad_num numeric;
    v_cantidad     integer;
    v_limpias      jsonb := '[]'::jsonb;  -- apuestas validadas y normalizadas
    v_total        bigint := 0;    -- bigint: 20 apuestas grandes no desbordan
    v_saldo        integer;
    v_id_juego     public.juego.id_juego%type;  -- integer
    v_byte         integer;
    v_numero       integer;
    v_color        text;
    v_gano         boolean;
    v_premio       bigint;
    v_premio_total bigint := 0;
    v_detalle      jsonb := '[]'::jsonb;
    v_resultado    text;
    v_id_partida   bigint;
    v_mov          bigint;
begin
    if v_uid is null then
        raise exception 'NO_AUTENTICADO';
    end if;

    -- 1) La entrada debe ser un arreglo con entre 1 y 20 apuestas.
    if p_apuestas is null
       or jsonb_typeof(p_apuestas) <> 'array'
       or jsonb_array_length(p_apuestas) < 1
       or jsonb_array_length(p_apuestas) > c_max_apuestas then
        raise exception 'APUESTAS_INVALIDAS';
    end if;

    -- 2) Validar cada apuesta y dejarla normalizada en v_limpias.
    for v_apuesta in select value from jsonb_array_elements(p_apuestas)
    loop
        if jsonb_typeof(v_apuesta) <> 'object' then
            raise exception 'APUESTA_INVALIDA';
        end if;

        -- Cantidad: número entero mayor a 0 que quepa en un integer.
        if jsonb_typeof(v_apuesta -> 'cantidad') is distinct from 'number' then
            raise exception 'APUESTA_INVALIDA';
        end if;
        v_cantidad_num := (v_apuesta ->> 'cantidad')::numeric;
        if v_cantidad_num <> trunc(v_cantidad_num)
           or v_cantidad_num <= 0
           or v_cantidad_num > 2147483647 then
            raise exception 'APUESTA_INVALIDA';
        end if;
        v_cantidad := v_cantidad_num::integer;

        -- Tipo y valor: sin importar mayúsculas ni espacios.
        -- ->> devuelve texto tanto si el valor vino como número (17) o como "17".
        v_tipo      := lower(trim(coalesce(v_apuesta ->> 'tipo', '')));
        v_valor_txt := upper(trim(coalesce(v_apuesta ->> 'valor', '')));

        if v_tipo in ('pleno', 'docena', 'columna') then
            -- Valores numéricos: solo dígitos (rechaza "1.5", "-3", "abc").
            if v_valor_txt !~ '^[0-9]{1,2}$' then
                raise exception 'APUESTA_INVALIDA';
            end if;
            v_valor_num := v_valor_txt::integer;
            if (v_tipo = 'pleno' and v_valor_num > 36)
               or (v_tipo <> 'pleno' and v_valor_num not between 1 and 3) then
                raise exception 'APUESTA_INVALIDA';
            end if;
            v_valor := to_jsonb(v_valor_num);
        elsif (v_tipo = 'color'   and v_valor_txt in ('ROJO', 'NEGRO'))
           or (v_tipo = 'paridad' and v_valor_txt in ('PAR', 'IMPAR'))
           or (v_tipo = 'mitad'   and v_valor_txt in ('BAJA', 'ALTA')) then
            v_valor := to_jsonb(v_valor_txt);
        else
            raise exception 'APUESTA_INVALIDA';
        end if;

        v_total  := v_total + v_cantidad;
        v_limpias := v_limpias || jsonb_build_array(jsonb_build_object(
            'tipo', v_tipo, 'valor', v_valor, 'cantidad', v_cantidad));
    end loop;

    -- 3) Bloquear la fila del usuario: si llegan dos giros a la vez,
    --    el segundo espera a que termine el primero y ve el saldo ya actualizado.
    select tokens into v_saldo from public.usuario where id_usuario = v_uid for update;
    if not found then
        raise exception 'PERFIL_NO_ENCONTRADO';
    end if;

    if v_total > v_saldo then
        raise exception 'SALDO_INSUFICIENTE';
    end if;

    -- nombre es UNIQUE en juego: se busca por nombre, nunca por un id fijo.
    select id_juego into v_id_juego
      from public.juego
     where nombre = 'Ruleta' and estado = true;

    if v_id_juego is null then
        raise exception 'JUEGO_NO_CONFIGURADO';
    end if;

    -- 4) Girar: número aleatorio uniforme de 0 a 36 (37 resultados).
    -- Un byte va de 0 a 255 (256 valores). 256 no es múltiplo de 37, así que
    -- byte % 37 directo haría que 0..33 salieran un poco más seguido.
    -- 222 = 37 x 6 es el mayor múltiplo de 37 que cabe en un byte: en 0..221
    -- cada número de 0 a 36 aparece exactamente 6 veces. Por eso se descartan
    -- los bytes >= 222 y se pide otro (muestreo por rechazo). Se descarta
    -- solo 34/256 ≈ 13 % de las veces, así que el bucle termina enseguida.
    loop
        v_byte := get_byte(extensions.gen_random_bytes(1), 0);
        exit when v_byte < 222;
    end loop;
    v_numero := v_byte % 37;

    v_color := case
                   when v_numero = 0 then 'VERDE'
                   when v_numero = any(c_rojos) then 'ROJO'
                   else 'NEGRO'
               end;

    -- 5) Calcular el premio de cada apuesta.
    for v_apuesta in select value from jsonb_array_elements(v_limpias)
    loop
        v_tipo     := v_apuesta ->> 'tipo';
        v_cantidad := (v_apuesta ->> 'cantidad')::integer;

        -- Con el 0, todo lo que no sea pleno pierde (por eso "v_numero <> 0").
        v_gano := case v_tipo
            when 'pleno'   then v_numero = (v_apuesta ->> 'valor')::integer
            when 'color'   then v_numero <> 0 and v_color = v_apuesta ->> 'valor'
            when 'paridad' then v_numero <> 0 and
                                (case when v_numero % 2 = 0 then 'PAR' else 'IMPAR' end)
                                = v_apuesta ->> 'valor'
            when 'mitad'   then v_numero <> 0 and
                                (case when v_numero <= 18 then 'BAJA' else 'ALTA' end)
                                = v_apuesta ->> 'valor'
            -- 1..12 -> 1, 13..24 -> 2, 25..36 -> 3
            when 'docena'  then v_numero <> 0 and
                                (v_numero - 1) / 12 + 1 = (v_apuesta ->> 'valor')::integer
            -- 1,4,7.. -> 1; 2,5,8.. -> 2; 3,6,9.. -> 3
            when 'columna' then v_numero <> 0 and
                                (v_numero - 1) % 3 + 1 = (v_apuesta ->> 'valor')::integer
            else false
        end;

        v_premio := case
            when not v_gano then 0
            when v_tipo = 'pleno' then v_cantidad::bigint * 36
            when v_tipo in ('docena', 'columna') then v_cantidad::bigint * 3
            else v_cantidad::bigint * 2
        end;

        v_premio_total := v_premio_total + v_premio;
        v_detalle := v_detalle || jsonb_build_array(jsonb_build_object(
            'tipo',     v_tipo,
            'valor',    v_apuesta -> 'valor',
            'cantidad', v_cantidad,
            'gano',     v_gano,
            'premio',   v_premio));
    end loop;

    v_resultado := case
                       when v_premio_total > v_total then 'GANADA'
                       when v_premio_total = v_total then 'EMPATE'
                       else 'PERDIDA'
                   end;

    -- 6) Registrar la partida: apuesta = total apostado, premio = total ganado.
    insert into public.partida (id_usuario, id_juego, apuesta, premio, resultado)
    values (v_uid, v_id_juego, v_total, v_premio_total, v_resultado)
    returning id_partida into v_id_partida;

    -- Movimiento APUESTA por el total, enlazado a la partida.
    insert into public.movimiento_token
           (id_usuario, id_partida, tipo, cantidad, saldo_anterior, saldo_nuevo)
    values (v_uid, v_id_partida, 'APUESTA', -v_total, v_saldo, v_saldo - v_total)
    returning id_movimiento into v_mov;

    v_saldo := v_saldo - v_total;

    -- Movimiento PREMIO, solo si ganó algo.
    if v_premio_total > 0 then
        insert into public.movimiento_token
               (id_usuario, id_partida, tipo, cantidad, saldo_anterior, saldo_nuevo)
        values (v_uid, v_id_partida, 'PREMIO', v_premio_total, v_saldo, v_saldo + v_premio_total)
        returning id_movimiento into v_mov;

        v_saldo := v_saldo + v_premio_total;
    end if;

    -- Un solo UPDATE con el saldo final (coincide con el último saldo_nuevo).
    update public.usuario set tokens = v_saldo where id_usuario = v_uid;

    return jsonb_build_object(
        'numero',        v_numero,
        'color',         v_color,
        'apuestas',      v_detalle,
        'apuesta_total', v_total,
        'premio_total',  v_premio_total,
        'resultado',     v_resultado,
        'saldo',         v_saldo
    );
end;
$$;


-- =====================================================================
-- Permisos
-- Supabase da EXECUTE por defecto a anon y authenticated sobre funciones
-- nuevas en "public", así que hay que quitarlo explícitamente.
-- =====================================================================
revoke execute on function public.ruleta_girar(jsonb) from public, anon;
grant  execute on function public.ruleta_girar(jsonb) to authenticated;

commit;
