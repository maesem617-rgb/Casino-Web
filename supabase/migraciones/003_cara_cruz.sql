-- =====================================================================
-- 003_cara_cruz.sql
-- Juego de Cara o cruz: una sola función RPC que lanza la moneda.
--
-- Idea general:
--   * El navegador solo envía la apuesta y la elección (CARA o CRUZ).
--   * La moneda se lanza AQUÍ, en el servidor, con gen_random_bytes
--     (fuente aleatoria criptográfica de pgcrypto).
--   * Partida, movimientos y saldo se registran en la misma transacción:
--     o se guarda todo, o no se guarda nada.
--
-- No crea tablas nuevas. Usa: usuario, juego, partida, movimiento_token.
-- No reutiliza auxiliares de 002_blackjack.sql: todos son propios del
-- Blackjack (mazo, totales, mano_blackjack).
-- Todo el archivo corre en una transacción: si algo falla, no se aplica nada.
-- =====================================================================

begin;

-- En Supabase ya viene instalada en "extensions"; esto no hace nada si existe.
create extension if not exists pgcrypto with schema extensions;


-- ---------------------------------------------------------------------
-- cara_cruz_jugar: cobra la apuesta, lanza la moneda y paga si acierta.
--   Acierta: premio = apuesta x 2 (recupera lo apostado + gana lo mismo).
--   Falla:   premio = 0.
-- ---------------------------------------------------------------------
create or replace function public.cara_cruz_jugar(p_apuesta integer, p_eleccion text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid        uuid := auth.uid();
    v_eleccion   text;
    v_saldo      integer;
    v_id_juego   public.juego.id_juego%type;  -- integer
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

    -- Lanzar la moneda: 1 byte aleatorio (0..255). 256 es par, así que
    -- el último bit vale 0 o 1 con exactamente 50 % de probabilidad.
    if (get_byte(extensions.gen_random_bytes(1), 0) & 1) = 0 then
        v_resultado := 'CARA';
    else
        v_resultado := 'CRUZ';
    end if;

    v_gano   := v_resultado = v_eleccion;
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
-- Permisos
-- Supabase da EXECUTE por defecto a anon y authenticated sobre funciones
-- nuevas en "public", así que hay que quitarlo explícitamente.
-- =====================================================================
revoke execute on function public.cara_cruz_jugar(integer, text) from public, anon;
grant  execute on function public.cara_cruz_jugar(integer, text) to authenticated;

commit;
