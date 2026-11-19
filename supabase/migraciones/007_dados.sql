-- =====================================================================
-- 007_dados.sql
-- Juego de Dados "7 arriba, 7 abajo": una sola función RPC que tira dos dados.
--
-- Idea general (mismo patrón que la Ruleta, 005_ruleta.sql):
--   * El navegador solo envía la lista de apuestas (tipo, valor, cantidad).
--   * Los dos dados se sacan AQUÍ, en el servidor, con gen_random_bytes
--     (fuente aleatoria criptográfica de pgcrypto).
--   * Partida, movimientos y saldo se registran en la misma transacción:
--     o se guarda todo, o no se guarda nada.
--   * Se pueden poner varias apuestas en una misma tirada (de 1 a 15).
--     En la tabla partida se guarda UNA fila por tirada con los totales.
--
-- Tipos de apuesta (el premio ya incluye lo apostado):
--   bajo     suma 2..6                 apuesta x 2
--   siete    suma = 7                  apuesta x 5
--   alto     suma 8..12                apuesta x 2
--   dobles   dado1 = dado2             apuesta x 5
--   suma     valor 2..6 u 8..12        2/12: x30 · 3/11: x15 · 4/10: x10
--            (el 7 no: para eso está   5/9: x7 · 6/8: x6
--             "siete")
-- Solo "suma" lleva "valor"; en los demás tipos mandar "valor" es inválido.
--
-- Retorno esperado al jugador (RTP) de cada apuesta.
-- Con dos dados hay 36 combinaciones igual de probables; la suma s sale en
-- (6 - |s - 7|) de ellas: 2→1, 3→2, 4→3, 5→4, 6→5, 7→6, 8→5 … 12→1.
--   bajo     15/36 x 2  = 30/36 ≈ 83.3 %
--   alto     15/36 x 2  = 30/36 ≈ 83.3 %
--   siete     6/36 x 5  = 30/36 ≈ 83.3 %
--   dobles    6/36 x 5  = 30/36 ≈ 83.3 %   (1-1, 2-2 … 6-6)
--   suma 2/12 1/36 x 30 = 30/36 ≈ 83.3 %
--   suma 3/11 2/36 x 15 = 30/36 ≈ 83.3 %
--   suma 4/10 3/36 x 10 = 30/36 ≈ 83.3 %
--   suma 5/9  4/36 x 7  = 28/36 ≈ 77.8 %
--   suma 6/8  5/36 x 6  = 30/36 ≈ 83.3 %
-- Es decir, a la larga la casa se queda con ~17 % (22 % en suma 5 o 9).
--
-- No crea tablas nuevas. Usa: usuario, juego, partida, movimiento_token.
-- Todo el archivo corre en una transacción: si algo falla, no se aplica nada.
-- =====================================================================

begin;

-- En Supabase ya viene instalada en "extensions"; esto no hace nada si existe.
create extension if not exists pgcrypto with schema extensions;


-- ---------------------------------------------------------------------
-- dados_tirar: valida las apuestas, cobra el total, tira los dados y paga.
--   p_apuestas: arreglo JSON, por ejemplo
--   [{"tipo":"alto","cantidad":20},
--    {"tipo":"suma","valor":11,"cantidad":5}]
-- ---------------------------------------------------------------------
create or replace function public.dados_tirar(p_apuestas jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    c_max_apuestas constant integer := 15;

    v_uid          uuid := auth.uid();
    v_apuesta      jsonb;          -- una apuesta tal como llegó
    v_tipo         text;
    v_valor_txt    text;
    v_valor_num    integer;
    v_valor        jsonb;          -- valor normalizado (número en "suma", null en el resto)
    v_cantidad_num numeric;
    v_cantidad     integer;
    v_limpias      jsonb := '[]'::jsonb;  -- apuestas validadas y normalizadas
    v_total        bigint := 0;    -- bigint: 15 apuestas grandes no desbordan
    v_saldo        integer;
    v_id_juego     public.juego.id_juego%type;  -- integer
    v_byte         integer;
    v_dado1        integer;
    v_dado2        integer;
    v_suma         integer;
    v_dobles       boolean;
    v_gano         boolean;
    v_multiplo     integer;
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

    -- 1) La entrada debe ser un arreglo con entre 1 y 15 apuestas.
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

        -- Tipo: sin importar mayúsculas ni espacios.
        v_tipo := lower(trim(coalesce(v_apuesta ->> 'tipo', '')));

        if v_tipo = 'suma' then
            -- ->> devuelve texto tanto si el valor vino como número (11) o como "11".
            -- Solo dígitos (rechaza "1.5", "-3", "abc" y la falta de valor).
            v_valor_txt := trim(coalesce(v_apuesta ->> 'valor', ''));
            if v_valor_txt !~ '^[0-9]{1,2}$' then
                raise exception 'APUESTA_INVALIDA';
            end if;
            v_valor_num := v_valor_txt::integer;
            -- 2..12 sin el 7 (el 7 se apuesta con el tipo "siete").
            if v_valor_num not between 2 and 12 or v_valor_num = 7 then
                raise exception 'APUESTA_INVALIDA';
            end if;
            v_valor := to_jsonb(v_valor_num);
        elsif v_tipo in ('bajo', 'siete', 'alto', 'dobles') then
            -- Estos tipos no llevan valor: si viene la llave "valor", es un error
            -- del cliente y se rechaza en vez de ignorarlo en silencio.
            if v_apuesta ? 'valor' then
                raise exception 'APUESTA_INVALIDA';
            end if;
            v_valor := 'null'::jsonb;
        else
            raise exception 'APUESTA_INVALIDA';
        end if;

        v_total   := v_total + v_cantidad;
        v_limpias := v_limpias || jsonb_build_array(jsonb_build_object(
            'tipo', v_tipo, 'valor', v_valor, 'cantidad', v_cantidad));
    end loop;

    -- 3) Bloquear la fila del usuario: si llegan dos tiradas a la vez,
    --    la segunda espera a que termine la primera y ve el saldo ya actualizado.
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
     where nombre = 'Dados' and estado = true;

    if v_id_juego is null then
        raise exception 'JUEGO_NO_CONFIGURADO';
    end if;

    -- 4) Tirar los dados: cada uno es un número uniforme de 1 a 6.
    -- Un byte va de 0 a 255 (256 valores). 256 no es múltiplo de 6
    -- (256 = 6 x 42 + 4), así que byte % 6 directo haría que 0..3 salieran
    -- un poco más seguido que 4 y 5. 252 = 6 x 42 es el mayor múltiplo de 6
    -- que cabe en un byte: en 0..251 cada resto de 0 a 5 aparece exactamente
    -- 42 veces. Por eso se descartan los bytes >= 252 y se pide otro (muestreo
    -- por rechazo). Solo se descarta 4/256 ≈ 1.6 % de las veces.
    loop
        v_byte := get_byte(extensions.gen_random_bytes(1), 0);
        exit when v_byte < 252;
    end loop;
    v_dado1 := v_byte % 6 + 1;

    loop
        v_byte := get_byte(extensions.gen_random_bytes(1), 0);
        exit when v_byte < 252;
    end loop;
    v_dado2 := v_byte % 6 + 1;

    v_suma   := v_dado1 + v_dado2;
    v_dobles := v_dado1 = v_dado2;

    -- 5) Calcular el premio de cada apuesta.
    for v_apuesta in select value from jsonb_array_elements(v_limpias)
    loop
        v_tipo     := v_apuesta ->> 'tipo';
        v_cantidad := (v_apuesta ->> 'cantidad')::integer;

        v_gano := case v_tipo
            when 'bajo'   then v_suma between 2 and 6
            when 'siete'  then v_suma = 7
            when 'alto'   then v_suma between 8 and 12
            when 'dobles' then v_dobles
            when 'suma'   then v_suma = (v_apuesta ->> 'valor')::integer
            else false
        end;

        -- Multiplicador del premio (incluye lo apostado).
        v_multiplo := case
            when v_tipo in ('bajo', 'alto')    then 2
            when v_tipo in ('siete', 'dobles') then 5
            -- suma: depende de qué tan difícil es sacar ese número.
            else case (v_apuesta ->> 'valor')::integer
                     when 2  then 30  when 12 then 30
                     when 3  then 15  when 11 then 15
                     when 4  then 10  when 10 then 10
                     when 5  then 7   when 9  then 7
                     else 6           -- 6 u 8
                 end
        end;

        v_premio := case when v_gano then v_cantidad::bigint * v_multiplo else 0 end;

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
        'dado1',         v_dado1,
        'dado2',         v_dado2,
        'suma',          v_suma,
        'dobles',        v_dobles,
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
revoke execute on function public.dados_tirar(jsonb) from public, anon;
grant  execute on function public.dados_tirar(jsonb) to authenticated;

commit;
