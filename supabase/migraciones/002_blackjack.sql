-- =====================================================================
-- 002_blackjack.sql
-- Juego de Blackjack (21): tabla de manos en curso + funciones RPC.
--
-- Idea general:
--   * El estado de la mano (mazo, cartas, carta oculta del crupier) vive
--     SOLO en el servidor, en la tabla mano_blackjack.
--   * El navegador no puede leer esa tabla: todo pasa por funciones
--     SECURITY DEFINER que devuelven únicamente lo que el jugador puede ver.
--   * Los tokens se descuentan / pagan dentro de esas funciones, en la misma
--     transacción que registra partida y movimiento_token.
--
-- Orden de bloqueo (igual en TODAS las funciones, para evitar deadlocks):
--   1) fila de usuario   (SELECT ... FOR UPDATE)
--   2) fila de mano_blackjack (SELECT ... FOR UPDATE)
--
-- Depende de las tablas existentes: usuario, juego, partida, movimiento_token.
-- Todo el archivo corre en una transacción: si algo falla, no se aplica nada.
-- =====================================================================

begin;

-- pgcrypto da gen_random_bytes(), una fuente aleatoria criptográfica.
-- En Supabase ya viene instalada en el esquema "extensions".
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Tabla: mano_blackjack
-- ---------------------------------------------------------------------
create table if not exists public.mano_blackjack (
    id_mano          bigint generated always as identity primary key,
    -- uuid porque usuario.id_usuario se enlaza con auth.uid().
    -- Si en la base real fuera otro tipo, esta línea falla y no se aplica nada.
    id_usuario       uuid        not null references public.usuario (id_usuario) on delete cascade,
    -- Total apostado en la mano (si el jugador dobla, se actualiza a apuesta x 2).
    apuesta          integer     not null check (apuesta > 0),
    doblada          boolean     not null default false,
    -- Cartas: arreglos jsonb de objetos {"valor": "A", "palo": "picas"}.
    mazo             jsonb       not null,
    cartas_jugador   jsonb       not null default '[]'::jsonb,
    cartas_crupier   jsonb       not null default '[]'::jsonb,
    estado           varchar(20) not null default 'en_juego'
                     check (estado in ('en_juego', 'terminada')),
    -- Resultado detallado de la mano (en partida se guarda GANADA/PERDIDA/EMPATE).
    resultado        varchar(20)
                     check (resultado in ('BLACKJACK', 'GANADA', 'EMPATE', 'PASADO', 'PERDIDA')),
    premio           integer     not null default 0 check (premio >= 0),
    id_partida       bigint      references public.partida (id_partida),
    -- Ids de los movimientos APUESTA de esta mano (1, o 2 si dobló),
    -- para enlazarlos con la partida cuando termine.
    ids_mov_apuesta  bigint[]    not null default '{}',
    creada_en        timestamptz not null default now(),
    terminada_en     timestamptz
);

comment on table public.mano_blackjack is
    'Estado privado de cada mano de Blackjack. Solo se accede mediante funciones blackjack_*.';

-- Un usuario solo puede tener UNA mano en juego a la vez.
create unique index if not exists mano_blackjack_una_en_juego
    on public.mano_blackjack (id_usuario)
    where estado = 'en_juego';

-- RLS activado y SIN políticas: nadie (anon / authenticated) puede leer ni escribir.
-- Además quitamos los permisos que Supabase da por defecto a las tablas nuevas.
alter table public.mano_blackjack enable row level security;
revoke all on table public.mano_blackjack from anon, authenticated;


-- ---------------------------------------------------------------------
-- Auxiliar: baraja un mazo nuevo de 52 cartas (Fisher-Yates).
-- ---------------------------------------------------------------------
create or replace function public.blackjack_aux_nuevo_mazo()
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
    v_valores text[] := array['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
    v_palos   text[] := array['picas','corazones','diamantes','treboles'];
    v_cartas  jsonb[] := '{}';
    v_valor   text;
    v_palo    text;
    v_tmp     jsonb;
    v_azar    bigint;
    i         int;
    j         int;
begin
    foreach v_palo in array v_palos loop
        foreach v_valor in array v_valores loop
            v_cartas := array_append(v_cartas, jsonb_build_object('valor', v_valor, 'palo', v_palo));
        end loop;
    end loop;

    -- Fisher-Yates: de la última posición a la segunda, intercambia con una al azar.
    for i in reverse 52..2 loop
        -- Número aleatorio de 32 bits tomado de gen_random_bytes (criptográfico).
        -- Se descartan los valores del "sobrante" para que todas las posiciones
        -- tengan exactamente la misma probabilidad (sin sesgo de módulo).
        loop
            v_azar := ('x' || lpad(encode(extensions.gen_random_bytes(4), 'hex'), 16, '0'))::bit(64)::bigint;
            exit when v_azar < 4294967296 - (4294967296 % i);
        end loop;
        j := (v_azar % i)::int + 1;

        v_tmp       := v_cartas[i];
        v_cartas[i] := v_cartas[j];
        v_cartas[j] := v_tmp;
    end loop;

    return to_jsonb(v_cartas);
end;
$$;


-- ---------------------------------------------------------------------
-- Auxiliar: total de una mano. El As vale 11 o 1, lo que más convenga.
-- ---------------------------------------------------------------------
create or replace function public.blackjack_aux_total(p_cartas jsonb)
returns integer
language plpgsql
immutable
set search_path = public
as $$
declare
    v_total integer;
    v_ases  integer;
begin
    select coalesce(sum(case
                when c->>'valor' = 'A' then 11
                when c->>'valor' in ('J', 'Q', 'K') then 10
                else (c->>'valor')::int
            end), 0),
           count(*) filter (where c->>'valor' = 'A')
      into v_total, v_ases
      from jsonb_array_elements(coalesce(p_cartas, '[]'::jsonb)) as c;

    -- Cada As que haga falta pasa de 11 a 1 (resta 10).
    while v_total > 21 and v_ases > 0 loop
        v_total := v_total - 10;
        v_ases  := v_ases - 1;
    end loop;

    return v_total;
end;
$$;


-- ---------------------------------------------------------------------
-- Auxiliar: arma la respuesta para el navegador.
-- Mientras la mano está en juego, la segunda carta del crupier NO se envía.
-- El mazo nunca se envía.
-- ---------------------------------------------------------------------
create or replace function public.blackjack_aux_vista(p_mano public.mano_blackjack, p_saldo integer)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
    v_en_juego boolean := p_mano.estado = 'en_juego';
    v_crupier  jsonb;
begin
    if v_en_juego then
        v_crupier := jsonb_build_array(p_mano.cartas_crupier -> 0);
    else
        v_crupier := p_mano.cartas_crupier;
    end if;

    return jsonb_build_object(
        'id_mano',         p_mano.id_mano,
        'estado',          p_mano.estado,
        'apuesta',         p_mano.apuesta,
        'doblada',         p_mano.doblada,
        'cartas_jugador',  p_mano.cartas_jugador,
        'total_jugador',   public.blackjack_aux_total(p_mano.cartas_jugador),
        'cartas_crupier',  v_crupier,
        'total_crupier',   public.blackjack_aux_total(v_crupier),
        'crupier_oculta',  v_en_juego,
        'puede_doblar',    v_en_juego
                           and not p_mano.doblada
                           and jsonb_array_length(p_mano.cartas_jugador) = 2
                           and p_saldo >= p_mano.apuesta,
        'resultado',       p_mano.resultado,
        'premio',          p_mano.premio,
        'saldo',           p_saldo
    );
end;
$$;


-- ---------------------------------------------------------------------
-- Auxiliar: termina una mano.
--   * (Opcional) juega el turno del crupier: pide hasta 17 o más.
--   * Calcula resultado y premio (enteros).
--   * Inserta partida, enlaza los movimientos APUESTA, paga el PREMIO.
-- Se llama SOLO desde las funciones blackjack_*, que ya tienen bloqueadas
-- las filas de usuario y mano (en ese orden).
-- ---------------------------------------------------------------------
create or replace function public.blackjack_aux_finalizar(p_id_mano bigint, p_jugar_crupier boolean)
returns void
language plpgsql
volatile
set search_path = public
as $$
declare
    m                public.mano_blackjack;
    v_total_jugador  integer;
    v_total_crupier  integer;
    v_natural_jug    boolean;
    v_natural_crup   boolean;
    v_resultado      varchar(20);
    v_res_partida    varchar(20);
    v_premio         integer;
    v_id_juego       public.juego.id_juego%type;  -- integer
    v_id_partida     bigint;
    v_saldo          integer;
begin
    select * into m from public.mano_blackjack where id_mano = p_id_mano;

    -- Turno del crupier: pide carta mientras tenga menos de 17.
    if p_jugar_crupier then
        while public.blackjack_aux_total(m.cartas_crupier) < 17 loop
            m.cartas_crupier := m.cartas_crupier || jsonb_build_array(m.mazo -> 0);
            m.mazo := m.mazo - 0;
        end loop;
    end if;

    v_total_jugador := public.blackjack_aux_total(m.cartas_jugador);
    v_total_crupier := public.blackjack_aux_total(m.cartas_crupier);
    v_natural_jug   := jsonb_array_length(m.cartas_jugador) = 2 and v_total_jugador = 21 and not m.doblada;
    v_natural_crup  := jsonb_array_length(m.cartas_crupier) = 2 and v_total_crupier = 21;

    -- Reglas de pago (m.apuesta = total apostado en la mano):
    --   Gana: apuesta x 2 | Blackjack: apuesta + floor(apuesta x 1.5)
    --   Empate: apuesta   | Pierde o se pasa: 0
    if v_total_jugador > 21 then
        v_resultado := 'PASADO';    v_premio := 0;
    elsif v_natural_jug and v_natural_crup then
        v_resultado := 'EMPATE';    v_premio := m.apuesta;
    elsif v_natural_jug then
        -- (apuesta * 3) / 2 con enteros = floor(apuesta * 1.5)
        v_resultado := 'BLACKJACK'; v_premio := m.apuesta + (m.apuesta * 3) / 2;
    elsif v_natural_crup then
        v_resultado := 'PERDIDA';   v_premio := 0;
    elsif v_total_crupier > 21 or v_total_jugador > v_total_crupier then
        v_resultado := 'GANADA';    v_premio := m.apuesta * 2;
    elsif v_total_jugador = v_total_crupier then
        v_resultado := 'EMPATE';    v_premio := m.apuesta;
    else
        v_resultado := 'PERDIDA';   v_premio := 0;
    end if;

    v_res_partida := case v_resultado
                         when 'BLACKJACK' then 'GANADA'
                         when 'GANADA'    then 'GANADA'
                         when 'EMPATE'    then 'EMPATE'
                         else 'PERDIDA'
                     end;

    -- nombre es UNIQUE en juego: se busca por nombre, nunca por un id fijo.
    select id_juego into v_id_juego
      from public.juego
     where nombre = 'Blackjack' and estado = true;

    if v_id_juego is null then
        raise exception 'JUEGO_NO_CONFIGURADO';
    end if;

    insert into public.partida (id_usuario, id_juego, apuesta, premio, resultado)
    values (m.id_usuario, v_id_juego, m.apuesta, v_premio, v_res_partida)
    returning id_partida into v_id_partida;

    -- Enlazar los movimientos APUESTA (1, o 2 si dobló) con la partida.
    update public.movimiento_token
       set id_partida = v_id_partida
     where id_movimiento = any (m.ids_mov_apuesta);

    -- Pagar el premio (la fila de usuario ya está bloqueada por quien llamó).
    if v_premio > 0 then
        select tokens into v_saldo from public.usuario where id_usuario = m.id_usuario;

        update public.usuario
           set tokens = tokens + v_premio
         where id_usuario = m.id_usuario;

        insert into public.movimiento_token
               (id_usuario, id_partida, tipo, cantidad, saldo_anterior, saldo_nuevo)
        values (m.id_usuario, v_id_partida, 'PREMIO', v_premio, v_saldo, v_saldo + v_premio);
    end if;

    update public.mano_blackjack
       set cartas_crupier = m.cartas_crupier,
           mazo           = m.mazo,
           estado         = 'terminada',
           resultado      = v_resultado,
           premio         = v_premio,
           id_partida     = v_id_partida,
           terminada_en   = now()
     where id_mano = m.id_mano;
end;
$$;


-- =====================================================================
-- Funciones RPC públicas (las que llama el navegador con supabase.rpc)
-- =====================================================================

-- ---------------------------------------------------------------------
-- blackjack_iniciar: cobra la apuesta, baraja y reparte.
-- Si el usuario ya tiene una mano en juego, la devuelve (se reanuda) sin cobrar.
-- ---------------------------------------------------------------------
create or replace function public.blackjack_iniciar(p_apuesta integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid    uuid := auth.uid();
    v_saldo  integer;
    v_mov    bigint;
    v_mazo   jsonb;
    m        public.mano_blackjack;
begin
    if v_uid is null then
        raise exception 'NO_AUTENTICADO';
    end if;

    -- 1) Bloquear la fila del usuario.
    select tokens into v_saldo from public.usuario where id_usuario = v_uid for update;
    if not found then
        raise exception 'PERFIL_NO_ENCONTRADO';
    end if;

    -- 2) ¿Ya hay una mano en juego? Se reanuda.
    select * into m from public.mano_blackjack
     where id_usuario = v_uid and estado = 'en_juego'
       for update;
    if found then
        return public.blackjack_aux_vista(m, v_saldo);
    end if;

    -- Validaciones de la apuesta.
    if p_apuesta is null or p_apuesta <= 0 then
        raise exception 'APUESTA_INVALIDA';
    end if;
    if p_apuesta > v_saldo then
        raise exception 'SALDO_INSUFICIENTE';
    end if;
    if not exists (select 1 from public.juego where nombre = 'Blackjack' and estado = true) then
        raise exception 'JUEGO_NO_CONFIGURADO';
    end if;

    -- Descontar la apuesta y registrar el movimiento.
    update public.usuario set tokens = tokens - p_apuesta where id_usuario = v_uid;

    insert into public.movimiento_token
           (id_usuario, id_partida, tipo, cantidad, saldo_anterior, saldo_nuevo)
    values (v_uid, null, 'APUESTA', -p_apuesta, v_saldo, v_saldo - p_apuesta)
    returning id_movimiento into v_mov;

    v_saldo := v_saldo - p_apuesta;

    -- Barajar y repartir alternando: jugador, crupier, jugador, crupier.
    v_mazo := public.blackjack_aux_nuevo_mazo();

    insert into public.mano_blackjack
           (id_usuario, apuesta, mazo, cartas_jugador, cartas_crupier, ids_mov_apuesta)
    values (v_uid,
            p_apuesta,
            v_mazo - 0 - 0 - 0 - 0,
            jsonb_build_array(v_mazo -> 0, v_mazo -> 2),
            jsonb_build_array(v_mazo -> 1, v_mazo -> 3),
            array[v_mov])
    returning * into m;

    -- Blackjack natural (del jugador o del crupier): se resuelve de inmediato.
    if public.blackjack_aux_total(m.cartas_jugador) = 21
       or public.blackjack_aux_total(m.cartas_crupier) = 21 then
        perform public.blackjack_aux_finalizar(m.id_mano, false);
        select * into m from public.mano_blackjack where id_mano = m.id_mano;
        select tokens into v_saldo from public.usuario where id_usuario = v_uid;
    end if;

    return public.blackjack_aux_vista(m, v_saldo);
end;
$$;


-- ---------------------------------------------------------------------
-- blackjack_pedir: da una carta al jugador.
-- Si se pasa de 21 la mano termina; si llega a 21 se planta solo.
-- ---------------------------------------------------------------------
create or replace function public.blackjack_pedir(p_id_mano bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid    uuid := auth.uid();
    v_saldo  integer;
    v_total  integer;
    m        public.mano_blackjack;
begin
    if v_uid is null then
        raise exception 'NO_AUTENTICADO';
    end if;

    -- 1) usuario, 2) mano
    select tokens into v_saldo from public.usuario where id_usuario = v_uid for update;
    if not found then
        raise exception 'PERFIL_NO_ENCONTRADO';
    end if;

    select * into m from public.mano_blackjack
     where id_mano = p_id_mano and id_usuario = v_uid
       for update;
    if not found then
        raise exception 'MANO_NO_ENCONTRADA';
    end if;
    if m.estado <> 'en_juego' then
        raise exception 'MANO_TERMINADA';
    end if;

    update public.mano_blackjack
       set cartas_jugador = cartas_jugador || jsonb_build_array(mazo -> 0),
           mazo           = mazo - 0
     where id_mano = m.id_mano
    returning * into m;

    v_total := public.blackjack_aux_total(m.cartas_jugador);

    if v_total > 21 then
        perform public.blackjack_aux_finalizar(m.id_mano, false);
    elsif v_total = 21 then
        perform public.blackjack_aux_finalizar(m.id_mano, true);
    end if;

    select * into m from public.mano_blackjack where id_mano = m.id_mano;
    select tokens into v_saldo from public.usuario where id_usuario = v_uid;
    return public.blackjack_aux_vista(m, v_saldo);
end;
$$;


-- ---------------------------------------------------------------------
-- blackjack_plantarse: juega el turno del crupier y resuelve.
-- ---------------------------------------------------------------------
create or replace function public.blackjack_plantarse(p_id_mano bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid    uuid := auth.uid();
    v_saldo  integer;
    m        public.mano_blackjack;
begin
    if v_uid is null then
        raise exception 'NO_AUTENTICADO';
    end if;

    -- 1) usuario, 2) mano
    select tokens into v_saldo from public.usuario where id_usuario = v_uid for update;
    if not found then
        raise exception 'PERFIL_NO_ENCONTRADO';
    end if;

    select * into m from public.mano_blackjack
     where id_mano = p_id_mano and id_usuario = v_uid
       for update;
    if not found then
        raise exception 'MANO_NO_ENCONTRADA';
    end if;
    if m.estado <> 'en_juego' then
        raise exception 'MANO_TERMINADA';
    end if;

    perform public.blackjack_aux_finalizar(m.id_mano, true);

    select * into m from public.mano_blackjack where id_mano = m.id_mano;
    select tokens into v_saldo from public.usuario where id_usuario = v_uid;
    return public.blackjack_aux_vista(m, v_saldo);
end;
$$;


-- ---------------------------------------------------------------------
-- blackjack_doblar: solo con 2 cartas y si alcanza el saldo.
-- Cobra otra apuesta igual (nuevo movimiento APUESTA), da UNA carta
-- y el crupier juega. partida.apuesta guardará el total (apuesta x 2).
-- ---------------------------------------------------------------------
create or replace function public.blackjack_doblar(p_id_mano bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid    uuid := auth.uid();
    v_saldo  integer;
    v_mov    bigint;
    m        public.mano_blackjack;
begin
    if v_uid is null then
        raise exception 'NO_AUTENTICADO';
    end if;

    -- 1) usuario, 2) mano
    select tokens into v_saldo from public.usuario where id_usuario = v_uid for update;
    if not found then
        raise exception 'PERFIL_NO_ENCONTRADO';
    end if;

    select * into m from public.mano_blackjack
     where id_mano = p_id_mano and id_usuario = v_uid
       for update;
    if not found then
        raise exception 'MANO_NO_ENCONTRADA';
    end if;
    if m.estado <> 'en_juego' then
        raise exception 'MANO_TERMINADA';
    end if;
    if m.doblada or jsonb_array_length(m.cartas_jugador) <> 2 then
        raise exception 'NO_PUEDE_DOBLAR';
    end if;
    if v_saldo < m.apuesta then
        raise exception 'SALDO_INSUFICIENTE';
    end if;

    -- Cobrar la segunda apuesta.
    update public.usuario set tokens = tokens - m.apuesta where id_usuario = v_uid;

    insert into public.movimiento_token
           (id_usuario, id_partida, tipo, cantidad, saldo_anterior, saldo_nuevo)
    values (v_uid, null, 'APUESTA', -m.apuesta, v_saldo, v_saldo - m.apuesta)
    returning id_movimiento into v_mov;

    -- Duplicar la apuesta y dar exactamente una carta.
    update public.mano_blackjack
       set apuesta         = apuesta * 2,
           doblada         = true,
           ids_mov_apuesta = array_append(ids_mov_apuesta, v_mov),
           cartas_jugador  = cartas_jugador || jsonb_build_array(mazo -> 0),
           mazo            = mazo - 0
     where id_mano = m.id_mano
    returning * into m;

    -- Si se pasó, el crupier no necesita jugar.
    perform public.blackjack_aux_finalizar(
        m.id_mano,
        public.blackjack_aux_total(m.cartas_jugador) <= 21
    );

    select * into m from public.mano_blackjack where id_mano = m.id_mano;
    select tokens into v_saldo from public.usuario where id_usuario = v_uid;
    return public.blackjack_aux_vista(m, v_saldo);
end;
$$;


-- ---------------------------------------------------------------------
-- blackjack_mano_actual: para reanudar al recargar la página.
-- Devuelve la mano en juego o {"estado": "sin_mano", "saldo": ...}.
-- ---------------------------------------------------------------------
create or replace function public.blackjack_mano_actual()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
    v_uid    uuid := auth.uid();
    v_saldo  integer;
    m        public.mano_blackjack;
begin
    if v_uid is null then
        raise exception 'NO_AUTENTICADO';
    end if;

    select tokens into v_saldo from public.usuario where id_usuario = v_uid;
    if not found then
        raise exception 'PERFIL_NO_ENCONTRADO';
    end if;

    select * into m from public.mano_blackjack
     where id_usuario = v_uid and estado = 'en_juego';

    if not found then
        return jsonb_build_object('estado', 'sin_mano', 'saldo', v_saldo);
    end if;

    return public.blackjack_aux_vista(m, v_saldo);
end;
$$;


-- =====================================================================
-- Permisos
-- Supabase da EXECUTE por defecto a anon y authenticated sobre funciones
-- nuevas en "public", así que hay que quitarlo explícitamente.
-- =====================================================================

-- Auxiliares: nadie desde el navegador.
revoke execute on function public.blackjack_aux_nuevo_mazo()                        from public, anon, authenticated;
revoke execute on function public.blackjack_aux_total(jsonb)                        from public, anon, authenticated;
revoke execute on function public.blackjack_aux_vista(public.mano_blackjack, integer) from public, anon, authenticated;
revoke execute on function public.blackjack_aux_finalizar(bigint, boolean)          from public, anon, authenticated;

-- RPC del juego: solo usuarios con sesión iniciada.
revoke execute on function public.blackjack_iniciar(integer)  from public, anon;
revoke execute on function public.blackjack_pedir(bigint)     from public, anon;
revoke execute on function public.blackjack_plantarse(bigint) from public, anon;
revoke execute on function public.blackjack_doblar(bigint)    from public, anon;
revoke execute on function public.blackjack_mano_actual()     from public, anon;

grant execute on function public.blackjack_iniciar(integer)  to authenticated;
grant execute on function public.blackjack_pedir(bigint)     to authenticated;
grant execute on function public.blackjack_plantarse(bigint) to authenticated;
grant execute on function public.blackjack_doblar(bigint)    to authenticated;
grant execute on function public.blackjack_mano_actual()     to authenticated;

commit;
