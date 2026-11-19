-- =====================================================================
-- 004_cara_cruz_probabilidad.sql
-- Cambia la probabilidad de Cara o cruz: 30 % jugador / 70 % casino.
--
-- La 003 ya está aplicada y no se modifica. Aquí se reemplaza la función
-- con CREATE OR REPLACE y la MISMA firma (p_apuesta integer, p_eleccion text),
-- así Postgres conserva los permisos. Igual se repiten el revoke/grant.
--
-- Cómo se decide ahora:
--   1) Primero se decide si el jugador gana (30 %), con un número aleatorio
--      uniforme de 0 a 99.
--   2) Después se elige el lado: el que eligió el jugador si gana, o el
--      contrario si pierde. Así la moneda siempre muestra un lado coherente.
-- Validaciones, bloqueo, partida, movimientos, premio x2 y JSON: igual que la 003.
-- Todo el archivo corre en una transacción: si algo falla, no se aplica nada.
-- =====================================================================

begin;

create or replace function public.cara_cruz_jugar(p_apuesta integer, p_eleccion text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    -- Probabilidad de que gane el jugador, en porcentaje (el casino gana el resto).
    c_prob_ganar_pct constant integer := 30;

    v_uid        uuid := auth.uid();
    v_eleccion   text;
    v_saldo      integer;
    v_id_juego   public.juego.id_juego%type;  -- integer
    v_byte       integer;
    v_numero     integer;
    v_resultado  text;
    v_gano       boolean;
    v_premio     integer;
    v_id_partida bigint;
    v_mov        bigint;
begin
    if v_uid is null then
        raise exception 'NO_AUTENTICADO';
    end if;

    -- Elección: solo CARA o CRUZ, sin importar mayúsculas ni espacios.
    v_eleccion := upper(trim(coalesce(p_eleccion, '')));
    if v_eleccion not in ('CARA', 'CRUZ') then
        raise exception 'ELECCION_INVALIDA';
    end if;

    if p_apuesta is null or p_apuesta <= 0 then
        raise exception 'APUESTA_INVALIDA';
    end if;

    -- Bloquear la fila del usuario: si llegan dos tiradas a la vez,
    -- la segunda espera a que termine la primera y ve el saldo ya actualizado.
    select tokens into v_saldo from public.usuario where id_usuario = v_uid for update;
    if not found then
        raise exception 'PERFIL_NO_ENCONTRADO';
    end if;

    if p_apuesta > v_saldo then
        raise exception 'SALDO_INSUFICIENTE';
    end if;

    -- nombre es UNIQUE en juego: se busca por nombre, nunca por un id fijo.
    select id_juego into v_id_juego
      from public.juego
     where nombre = 'Cara o cruz' and estado = true;

    if v_id_juego is null then
        raise exception 'JUEGO_NO_CONFIGURADO';
    end if;

    -- Número aleatorio uniforme de 0 a 99.
    -- Un byte va de 0 a 255; si usáramos byte % 100 directamente, los números
    -- 0..55 saldrían más seguido (256 no es múltiplo de 100). Por eso se
    -- descartan los bytes >= 200 y se pide otro (muestreo por rechazo):
    -- 0..199 tiene exactamente 2 bytes para cada número de 0 a 99.
    loop
        v_byte := get_byte(extensions.gen_random_bytes(1), 0);
        exit when v_byte < 200;
    end loop;
    v_numero := v_byte % 100;

    v_gano := v_numero < c_prob_ganar_pct;

    -- El lado que cae: el elegido si gana, el contrario si pierde.
    if v_gano then
        v_resultado := v_eleccion;
    elsif v_eleccion = 'CARA' then
        v_resultado := 'CRUZ';
    else
        v_resultado := 'CARA';
    end if;

    v_premio := case when v_gano then p_apuesta * 2 else 0 end;

    -- Registrar la partida (nunca hay empate en Cara o cruz).
    insert into public.partida (id_usuario, id_juego, apuesta, premio, resultado)
    values (v_uid, v_id_juego, p_apuesta, v_premio,
            case when v_gano then 'GANADA' else 'PERDIDA' end)
    returning id_partida into v_id_partida;

    -- Movimiento APUESTA, enlazado a la partida.
    insert into public.movimiento_token
           (id_usuario, id_partida, tipo, cantidad, saldo_anterior, saldo_nuevo)
    values (v_uid, v_id_partida, 'APUESTA', -p_apuesta, v_saldo, v_saldo - p_apuesta)
    returning id_movimiento into v_mov;

    v_saldo := v_saldo - p_apuesta;

    -- Movimiento PREMIO, solo si acertó.
    if v_premio > 0 then
        insert into public.movimiento_token
               (id_usuario, id_partida, tipo, cantidad, saldo_anterior, saldo_nuevo)
        values (v_uid, v_id_partida, 'PREMIO', v_premio, v_saldo, v_saldo + v_premio)
        returning id_movimiento into v_mov;

        v_saldo := v_saldo + v_premio;
    end if;

    -- Un solo UPDATE con el saldo final (coincide con el último saldo_nuevo).
    update public.usuario set tokens = v_saldo where id_usuario = v_uid;

    return jsonb_build_object(
        'eleccion',  v_eleccion,
        'resultado', v_resultado,
        'gano',      v_gano,
        'apuesta',   p_apuesta,
        'premio',    v_premio,
        'saldo',     v_saldo
    );
end;
$$;


-- =====================================================================
-- Permisos (CREATE OR REPLACE ya los conserva; se repiten por si acaso).
-- =====================================================================
revoke execute on function public.cara_cruz_jugar(integer, text) from public, anon;
grant  execute on function public.cara_cruz_jugar(integer, text) to authenticated;

commit;
