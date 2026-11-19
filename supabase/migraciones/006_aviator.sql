-- =====================================================================
-- 006_aviator.sql
-- Juego Aviator con tormentas: tabla de vuelos en curso + funciones RPC.
--
-- Idea general:
--   * El jugador apuesta y el avión despega. El multiplicador crece con el
--     tiempo:  multiplicador(t) = e^(VELOCIDAD · t), con t en segundos
--     medidos con el RELOJ DEL SERVIDOR (now() - inicio).
--   * En la ruta hay tormentas en posiciones fijas (1.05×, 1.15×, ...).
--     Al despegar, el servidor sortea en secreto cuáles son fatales.
--     Si el avión cruza una tormenta fatal, cae y el jugador pierde todo.
--   * El jugador se retira cuando quiere: premio = floor(apuesta × multiplicador).
--   * Si llega al MÁXIMO (50×), se retira solo.
--   * La tabla vuelo_aviator (con las tormentas fatales) vive SOLO en el
--     servidor: el navegador no puede leerla. Las funciones aviator_* solo
--     revelan las tormentas que el avión ya dejó atrás.
--
-- Cómo se eligen las probabilidades (resumen; detalle en el PR):
--   Si hubiera un tramo sin riesgo, el jugador podría retirarse justo antes
--   de la siguiente tormenta y ganar siempre. Por eso cada tormenta "paga" el
--   tramo seguro que viene después:
--       p_fatal(tormenta i) = 1 - posicion(i) / posicion(i+1)
--   La primera tormenta está en la pista (1.00×) y además cobra la ventaja
--   de la casa:
--       p_fatal(pista) = 1 - RETORNO × 1.00 / 1.05
--   Resultado: la probabilidad de seguir en el aire al llegar a un
--   multiplicador m es RETORNO / m, así que el retorno esperado es el mismo
--   (RETORNO = 90 %) sin importar cuándo te retires.
--
-- Orden de bloqueo (igual en TODAS las funciones, para evitar deadlocks):
--   1) fila de usuario       (SELECT ... FOR UPDATE)
--   2) fila de vuelo_aviator (SELECT ... FOR UPDATE)
--
-- Depende de las tablas existentes: usuario, juego, partida, movimiento_token.
-- Todo el archivo corre en una transacción: si algo falla, no se aplica nada.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- LIMPIEZA: objetos de la primera versión de Aviator.
-- Se crearon a mano desde el panel de Supabase (sin migración), así que no
-- están en el repo y no conocemos sus firmas exactas. Esta migración los
-- reemplaza:
--   * funciones public.aviator_iniciar / aviator_estado / aviator_retirar
--     (cualquier firma; la vieja aviator_estado usaba p_id_ronda y por eso
--     CREATE OR REPLACE fallaba con el error 42P13);
--   * tabla public.aviator_ronda.
-- NO se tocan partida ni movimiento_token: las partidas ya jugadas se conservan.
-- Las funciones nuevas se crean más abajo, así que este bloque no las borra.
-- Sin CASCADE: si algo dependiera de estos objetos, la migración falla
-- completa (no se aplica nada) en lugar de borrar cosas de más.
-- ---------------------------------------------------------------------
do $$
declare
    f record;
begin
    for f in
        select p.proname, pg_get_function_identity_arguments(p.oid) as args
          from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and p.proname in ('aviator_iniciar', 'aviator_estado', 'aviator_retirar')
    loop
        raise notice 'Eliminando función vieja: public.%(%)', f.proname, f.args;
        execute format('drop function public.%I(%s)', f.proname, f.args);
    end loop;
end;
$$;

drop table if exists public.aviator_ronda;

-- pgcrypto da gen_random_bytes(), una fuente aleatoria criptográfica.
-- En Supabase ya viene instalada en el esquema "extensions".
create extension if not exists pgcrypto with schema extensions;


-- ---------------------------------------------------------------------
-- CONSTANTES DEL JUEGO
-- Todas las funciones las leen de aquí. Si se cambia algo, hay que volver
-- a calcular el retorno esperado (ver el comentario del inicio).
-- ---------------------------------------------------------------------
create or replace function public.aviator_aux_config()
returns jsonb
language sql
immutable
set search_path = public
as $$
    select jsonb_build_object(
        -- Velocidad de crecimiento (por segundo): ×2 a los 8.9 s, 50× a los 50 s.
        'velocidad',       0.078,
        -- Multiplicador máximo: al llegar aquí el jugador se retira solo.
        'maximo',          50,
        -- Retorno esperado para el jugador (0.90 = 90 %; la casa gana 10 %).
        'retorno',         0.90,
        -- Margen por latencia (segundos): al retirarse, el servidor evalúa el
        -- vuelo como estaba hace este tiempo (≈ cuando el jugador hizo clic).
        'margen_segundos', 0.20,
        -- Posiciones de las tormentas (multiplicadores). La de 1.00× está en la
        -- pista. Al principio están juntas (tramos cortos y tormentas suaves) y
        -- luego se separan (tramos largos y tormentas más peligrosas).
        'tormentas',       jsonb_build_array(
                               1.00, 1.05, 1.15, 1.30, 1.50, 1.75, 2.10, 2.60, 3.20,
                               4.00, 5.20, 7.00, 9.50, 13.00, 18.00, 25.00, 35.00)
    );
$$;


-- ---------------------------------------------------------------------
-- Tabla: vuelo_aviator
-- ---------------------------------------------------------------------
create table if not exists public.vuelo_aviator (
    id_vuelo             bigint generated always as identity primary key,
    id_usuario           uuid         not null references public.usuario (id_usuario) on delete cascade,
    apuesta              integer      not null check (apuesta > 0),
    -- Hora del servidor en que despegó. El multiplicador se calcula con now() - inicio.
    inicio               timestamptz  not null default now(),
    -- Arreglo de objetos {"m": 2.10, "fatal": false}, ordenado por m. SECRETO.
    tormentas            jsonb        not null,
    -- Multiplicador de la primera tormenta fatal (null si ninguna lo es).
    multiplicador_crash  numeric(8,2),
    estado               varchar(10)  not null default 'en_vuelo'
                         check (estado in ('en_vuelo', 'retirado', 'caido')),
    multiplicador_retiro numeric(8,2),
    premio               integer      not null default 0 check (premio >= 0),
    id_partida           bigint       references public.partida (id_partida),
    id_mov_apuesta       bigint       references public.movimiento_token (id_movimiento),
    id_mov_premio        bigint       references public.movimiento_token (id_movimiento),
    creado_en            timestamptz  not null default now(),
    terminado_en         timestamptz
);

comment on table public.vuelo_aviator is
    'Estado privado de cada vuelo de Aviator (incluye qué tormentas son fatales). Solo se accede mediante funciones aviator_*.';

-- Un usuario solo puede tener UN vuelo en el aire a la vez.
create unique index if not exists vuelo_aviator_uno_en_vuelo
    on public.vuelo_aviator (id_usuario)
    where estado = 'en_vuelo';

-- RLS activado y SIN políticas: nadie (anon / authenticated) puede leer ni escribir.
-- Además quitamos los permisos que Supabase da por defecto a las tablas nuevas.
alter table public.vuelo_aviator enable row level security;
revoke all on table public.vuelo_aviator from anon, authenticated;


-- ---------------------------------------------------------------------
-- Catálogo: agregar Aviator si no existe. Dados NO se toca.
-- ---------------------------------------------------------------------
insert into public.juego (nombre, descripcion, imagen, ruta, estado)
values ('Aviator', 'Retírate antes de que la tormenta te derribe.', 'aviator.png', '/juegos/aviator', true)
on conflict (nombre) do nothing;


-- ---------------------------------------------------------------------
-- Auxiliar: segundos transcurridos desde el despegue (reloj del servidor).
-- ---------------------------------------------------------------------
create or replace function public.aviator_aux_segundos(p_inicio timestamptz)
returns double precision
language sql
stable
set search_path = public
as $$
    select greatest(extract(epoch from (now() - p_inicio))::double precision, 0);
$$;


-- ---------------------------------------------------------------------
-- Auxiliar: multiplicador exacto a los p_t segundos (sin redondear, con tope).
-- ---------------------------------------------------------------------
create or replace function public.aviator_aux_multiplicador(p_t double precision)
returns double precision
language sql
immutable
set search_path = public
as $$
    select least(
        exp((public.aviator_aux_config() ->> 'velocidad')::double precision * greatest(p_t, 0)),
        (public.aviator_aux_config() ->> 'maximo')::double precision
    );
$$;


-- ---------------------------------------------------------------------
-- Auxiliar: redondea un multiplicador HACIA ABAJO a 2 decimales (2.379 -> 2.37).
-- ---------------------------------------------------------------------
create or replace function public.aviator_aux_dos_decimales(p_m double precision)
returns numeric
language sql
immutable
set search_path = public
as $$
    select (floor(p_m * 100) / 100)::numeric(8,2);
$$;


-- ---------------------------------------------------------------------
-- Auxiliar: entero aleatorio uniforme en [0, p_n) con gen_random_bytes.
-- Se descartan los valores del "sobrante" de 2^32 para que todos los
-- resultados tengan exactamente la misma probabilidad (sin sesgo de módulo).
-- ---------------------------------------------------------------------
create or replace function public.aviator_aux_azar(p_n bigint)
returns bigint
language plpgsql
volatile
set search_path = public
as $$
declare
    v_azar bigint;
begin
    loop
        v_azar := ('x' || lpad(encode(extensions.gen_random_bytes(4), 'hex'), 16, '0'))::bit(64)::bigint;
        exit when v_azar < 4294967296 - (4294967296 % p_n);
    end loop;
    return v_azar % p_n;
end;
$$;


-- ---------------------------------------------------------------------
-- Auxiliar: genera las tormentas de un vuelo y sortea cuáles son fatales.
-- Devuelve [{"m": 1.00, "fatal": true|false}, {"m": 1.05, ...}, ...].
-- ---------------------------------------------------------------------
create or replace function public.aviator_aux_generar_tormentas()
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
    c_escala constant bigint := 1000000;   -- probabilidades con 6 decimales
    v_cfg       jsonb   := public.aviator_aux_config();
    v_retorno   numeric := (v_cfg ->> 'retorno')::numeric;
    v_pos       numeric[];
    v_n         integer;
    v_siguiente numeric;
    v_p         numeric;
    v_umbral    bigint;
    v_res       jsonb := '[]'::jsonb;
    i           integer;
begin
    select array_agg(value::numeric order by ord)
      into v_pos
      from jsonb_array_elements_text(v_cfg -> 'tormentas') with ordinality as t(value, ord);
    v_n := array_length(v_pos, 1);

    for i in 1..v_n loop
        -- Posición siguiente: la próxima tormenta, o el máximo si es la última.
        if i < v_n then
            v_siguiente := v_pos[i + 1];
        else
            v_siguiente := (v_cfg ->> 'maximo')::numeric;
        end if;

        -- p = 1 - pos(i) / pos(i+1); la tormenta de la pista además
        -- multiplica por RETORNO (ahí está la ventaja de la casa).
        v_p := 1 - v_pos[i] / v_siguiente * (case when i = 1 then v_retorno else 1 end);

        -- Fatal si un número al azar en [0, 1 000 000) cae por debajo del umbral.
        -- ceil redondea a favor de la casa (máximo 0.0001 %).
        v_umbral := ceil(v_p * c_escala)::bigint;

        v_res := v_res || jsonb_build_array(jsonb_build_object(
            'm',     v_pos[i],
            'fatal', public.aviator_aux_azar(c_escala) < v_umbral));
    end loop;

    return v_res;
end;
$$;


-- ---------------------------------------------------------------------
-- Auxiliar: arma la respuesta para el navegador.
-- Mientras el avión vuela, solo se revelan las tormentas ya cruzadas
-- (todas fueron seguras: si no, el vuelo ya estaría "caido").
-- Cuando el vuelo termina se revela el mapa completo.
-- ---------------------------------------------------------------------
create or replace function public.aviator_aux_vista(p_vuelo public.vuelo_aviator, p_saldo integer)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
    v_cfg       jsonb := public.aviator_aux_config();
    v_en_vuelo  boolean := p_vuelo.estado = 'en_vuelo';
    v_t         double precision := public.aviator_aux_segundos(p_vuelo.inicio);
    v_m_actual  double precision := public.aviator_aux_multiplicador(v_t);
    -- Hasta dónde llegó el avión (para marcar tormentas cruzadas).
    v_hasta     numeric;
    v_tormentas jsonb;
begin
    v_hasta := case p_vuelo.estado
                   when 'en_vuelo' then v_m_actual::numeric
                   when 'caido'    then p_vuelo.multiplicador_crash
                   else p_vuelo.multiplicador_retiro
               end;

    select coalesce(jsonb_agg(jsonb_build_object(
               'm',       (e ->> 'm')::numeric,
               'cruzada', (e ->> 'm')::numeric <= v_hasta,
               -- En vuelo: null = todavía es un secreto.
               'fatal',   case
                              when not v_en_vuelo then (e ->> 'fatal')::boolean
                              when (e ->> 'm')::numeric <= v_hasta then (e ->> 'fatal')::boolean
                              else null
                          end
           ) order by ord), '[]'::jsonb)
      into v_tormentas
      from jsonb_array_elements(p_vuelo.tormentas) with ordinality as t(e, ord);

    return jsonb_build_object(
        'id_vuelo',             p_vuelo.id_vuelo,
        'estado',               p_vuelo.estado,
        'apuesta',              p_vuelo.apuesta,
        -- Horas en milisegundos (epoch) para que el navegador sincronice su reloj.
        'inicio_ms',            round(extract(epoch from p_vuelo.inicio) * 1000),
        'ahora_ms',             round(extract(epoch from now()) * 1000),
        'velocidad',            (v_cfg ->> 'velocidad')::numeric,
        'maximo',               (v_cfg ->> 'maximo')::numeric,
        'tormentas',            v_tormentas,
        'multiplicador_actual', case when v_en_vuelo then public.aviator_aux_dos_decimales(v_m_actual) end,
        'multiplicador_crash',  case when p_vuelo.estado = 'caido' then p_vuelo.multiplicador_crash end,
        'multiplicador_retiro', p_vuelo.multiplicador_retiro,
        'premio',               p_vuelo.premio,
        'saldo',                p_saldo
    );
end;
$$;


-- ---------------------------------------------------------------------
-- Auxiliar: id de Aviator en el catálogo (por nombre, nunca un id fijo).
-- ---------------------------------------------------------------------
create or replace function public.aviator_aux_id_juego()
returns integer
language plpgsql
stable
set search_path = public
as $$
declare
    v_id public.juego.id_juego%type;
begin
    select id_juego into v_id from public.juego where nombre = 'Aviator' and estado = true;
    if v_id is null then
        raise exception 'JUEGO_NO_CONFIGURADO';
    end if;
    return v_id;
end;
$$;


-- ---------------------------------------------------------------------
-- Auxiliar: cierra el vuelo como CAÍDO (partida PERDIDA, premio 0).
-- Quien llama ya tiene bloqueadas las filas de usuario y vuelo.
-- ---------------------------------------------------------------------
create or replace function public.aviator_aux_caer(p_id_vuelo bigint)
returns void
language plpgsql
volatile
set search_path = public
as $$
declare
    v          public.vuelo_aviator;
    v_id_part  bigint;
begin
    select * into v from public.vuelo_aviator where id_vuelo = p_id_vuelo;

    insert into public.partida (id_usuario, id_juego, apuesta, premio, resultado)
    values (v.id_usuario, public.aviator_aux_id_juego(), v.apuesta, 0, 'PERDIDA')
    returning id_partida into v_id_part;

    -- Enlazar el movimiento APUESTA con la partida.
    update public.movimiento_token
       set id_partida = v_id_part
     where id_movimiento = v.id_mov_apuesta;

    update public.vuelo_aviator
       set estado       = 'caido',
           premio       = 0,
           id_partida   = v_id_part,
           terminado_en = now()
     where id_vuelo = p_id_vuelo;
end;
$$;


-- ---------------------------------------------------------------------
-- Auxiliar: cierra el vuelo como RETIRADO y paga floor(apuesta × p_mult).
-- Si el premio es igual a la apuesta (retiro a 1.00×) la partida es EMPATE.
-- Quien llama ya tiene bloqueadas las filas de usuario y vuelo.
-- ---------------------------------------------------------------------
create or replace function public.aviator_aux_pagar(p_id_vuelo bigint, p_mult numeric)
returns void
language plpgsql
volatile
set search_path = public
as $$
declare
    v          public.vuelo_aviator;
    v_premio   integer;
    v_saldo    integer;
    v_id_part  bigint;
    v_id_mov   bigint;
begin
    select * into v from public.vuelo_aviator where id_vuelo = p_id_vuelo;

    -- numeric × numeric es exacto; floor deja un entero.
    v_premio := floor(v.apuesta * p_mult)::integer;

    insert into public.partida (id_usuario, id_juego, apuesta, premio, resultado)
    values (v.id_usuario, public.aviator_aux_id_juego(), v.apuesta, v_premio,
            case when v_premio > v.apuesta then 'GANADA' else 'EMPATE' end)
    returning id_partida into v_id_part;

    update public.movimiento_token
       set id_partida = v_id_part
     where id_movimiento = v.id_mov_apuesta;

    -- Pagar el premio (la fila de usuario ya está bloqueada por quien llamó).
    select tokens into v_saldo from public.usuario where id_usuario = v.id_usuario;

    update public.usuario
       set tokens = tokens + v_premio
     where id_usuario = v.id_usuario;

    insert into public.movimiento_token
           (id_usuario, id_partida, tipo, cantidad, saldo_anterior, saldo_nuevo)
    values (v.id_usuario, v_id_part, 'PREMIO', v_premio, v_saldo, v_saldo + v_premio)
    returning id_movimiento into v_id_mov;

    update public.vuelo_aviator
       set estado               = 'retirado',
           multiplicador_retiro = p_mult,
           premio               = v_premio,
           id_partida           = v_id_part,
           id_mov_premio        = v_id_mov,
           terminado_en         = now()
     where id_vuelo = p_id_vuelo;
end;
$$;


-- ---------------------------------------------------------------------
-- Auxiliar: revisa un vuelo en el aire con el reloj del servidor.
--   * Si ya cruzó la tormenta fatal  -> lo cierra como caído.
--   * Si ya llegó al máximo           -> lo retira solo con el máximo.
--   * Si no, no hace nada (sigue en el aire).
-- ---------------------------------------------------------------------
create or replace function public.aviator_aux_resolver(p_id_vuelo bigint)
returns void
language plpgsql
volatile
set search_path = public
as $$
declare
    v    public.vuelo_aviator;
    v_m  double precision;
begin
    select * into v from public.vuelo_aviator where id_vuelo = p_id_vuelo;
    if v.estado <> 'en_vuelo' then
        return;
    end if;

    v_m := public.aviator_aux_multiplicador(public.aviator_aux_segundos(v.inicio));

    if v.multiplicador_crash is not null and v_m >= v.multiplicador_crash then
        perform public.aviator_aux_caer(v.id_vuelo);
    elsif v_m >= (public.aviator_aux_config() ->> 'maximo')::double precision then
        perform public.aviator_aux_pagar(v.id_vuelo, (public.aviator_aux_config() ->> 'maximo')::numeric);
    end if;
end;
$$;


-- =====================================================================
-- Funciones RPC públicas (las que llama el navegador con supabase.rpc)
-- =====================================================================

-- ---------------------------------------------------------------------
-- aviator_despegar: cobra la apuesta, sortea las tormentas y despega.
-- Si el usuario ya tiene un vuelo en el aire, lo devuelve sin cobrar.
-- La tormenta de la pista (1.00×) se resuelve aquí mismo: si es fatal,
-- el vuelo termina antes de que el jugador pueda retirarse.
-- ---------------------------------------------------------------------
create or replace function public.aviator_despegar(p_apuesta integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid        uuid := auth.uid();
    v_saldo      integer;
    v_mov        bigint;
    v_tormentas  jsonb;
    v_crash      numeric;
    v            public.vuelo_aviator;
begin
    if v_uid is null then
        raise exception 'NO_AUTENTICADO';
    end if;

    -- 1) Bloquear la fila del usuario.
    select tokens into v_saldo from public.usuario where id_usuario = v_uid for update;
    if not found then
        raise exception 'PERFIL_NO_ENCONTRADO';
    end if;

    -- 2) ¿Ya hay un vuelo en el aire? Primero se revisa con el reloj del
    --    servidor (pudo caer o llegar al máximo mientras tanto).
    select * into v from public.vuelo_aviator
     where id_usuario = v_uid and estado = 'en_vuelo'
       for update;
    if found then
        perform public.aviator_aux_resolver(v.id_vuelo);
        select * into v from public.vuelo_aviator where id_vuelo = v.id_vuelo;
        if v.estado = 'en_vuelo' then
            return public.aviator_aux_vista(v, v_saldo) || jsonb_build_object('reanudado', true);
        end if;
        -- Ya terminó (y quizá se pagó): se sigue con un vuelo nuevo.
        select tokens into v_saldo from public.usuario where id_usuario = v_uid;
    end if;

    -- Validaciones de la apuesta.
    if p_apuesta is null or p_apuesta <= 0 then
        raise exception 'APUESTA_INVALIDA';
    end if;
    if p_apuesta > v_saldo then
        raise exception 'SALDO_INSUFICIENTE';
    end if;
    -- El saldo es integer: el premio máximo (apuesta × 50) debe caber.
    if (v_saldo - p_apuesta)::bigint
       + p_apuesta::bigint * (public.aviator_aux_config() ->> 'maximo')::bigint > 2147483647 then
        raise exception 'APUESTA_DEMASIADO_ALTA';
    end if;
    perform public.aviator_aux_id_juego();  -- lanza JUEGO_NO_CONFIGURADO si falta

    -- Descontar la apuesta y registrar el movimiento.
    update public.usuario set tokens = tokens - p_apuesta where id_usuario = v_uid;

    insert into public.movimiento_token
           (id_usuario, id_partida, tipo, cantidad, saldo_anterior, saldo_nuevo)
    values (v_uid, null, 'APUESTA', -p_apuesta, v_saldo, v_saldo - p_apuesta)
    returning id_movimiento into v_mov;

    v_saldo := v_saldo - p_apuesta;

    -- Sortear las tormentas. El crash es la PRIMERA tormenta fatal.
    v_tormentas := public.aviator_aux_generar_tormentas();

    select min((e ->> 'm')::numeric) into v_crash
      from jsonb_array_elements(v_tormentas) as e
     where (e ->> 'fatal')::boolean;

    insert into public.vuelo_aviator
           (id_usuario, apuesta, inicio, tormentas, multiplicador_crash, id_mov_apuesta)
    values (v_uid, p_apuesta, now(), v_tormentas, v_crash, v_mov)
    returning * into v;

    -- Tormenta de la pista (1.00×): si es fatal, cae en este mismo momento.
    perform public.aviator_aux_resolver(v.id_vuelo);

    select * into v from public.vuelo_aviator where id_vuelo = v.id_vuelo;
    select tokens into v_saldo from public.usuario where id_usuario = v_uid;
    return public.aviator_aux_vista(v, v_saldo);
end;
$$;


-- ---------------------------------------------------------------------
-- aviator_estado: revisa el vuelo con el reloj del servidor.
-- El navegador la llama al llegar a cada tormenta (y al máximo).
-- ---------------------------------------------------------------------
create or replace function public.aviator_estado(p_id_vuelo bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid    uuid := auth.uid();
    v_saldo  integer;
    v        public.vuelo_aviator;
begin
    if v_uid is null then
        raise exception 'NO_AUTENTICADO';
    end if;

    -- 1) usuario, 2) vuelo
    select tokens into v_saldo from public.usuario where id_usuario = v_uid for update;
    if not found then
        raise exception 'PERFIL_NO_ENCONTRADO';
    end if;

    select * into v from public.vuelo_aviator
     where id_vuelo = p_id_vuelo and id_usuario = v_uid
       for update;
    if not found then
        raise exception 'VUELO_NO_ENCONTRADO';
    end if;

    perform public.aviator_aux_resolver(v.id_vuelo);

    select * into v from public.vuelo_aviator where id_vuelo = v.id_vuelo;
    select tokens into v_saldo from public.usuario where id_usuario = v_uid;
    return public.aviator_aux_vista(v, v_saldo);
end;
$$;


-- ---------------------------------------------------------------------
-- aviator_retirarse: el jugador cobra con el multiplicador del SERVIDOR.
-- El navegador no envía ningún multiplicador, solo el id del vuelo.
--
-- Latencia: el clic tarda unas décimas en llegar. Para no castigar eso,
-- el vuelo se evalúa como estaba hace MARGEN segundos (0.20 s):
--   * si en ese momento todavía no cruzaba la tormenta fatal, cobra;
--   * el premio usa el multiplicador de ese mismo momento.
-- Así no hay ventaja posible: retirarse "tarde" con margen equivale
-- exactamente a haberse retirado 0.20 s antes, sin saber nada nuevo.
--
-- Si el vuelo ya había terminado (doble clic, o ya cayó), devuelve el
-- estado sin pagar nada otra vez ("ya_terminado": true).
-- ---------------------------------------------------------------------
create or replace function public.aviator_retirarse(p_id_vuelo bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid     uuid := auth.uid();
    v_cfg     jsonb := public.aviator_aux_config();
    v_saldo   integer;
    v_t       double precision;
    v_m_real  double precision;
    v_m_clic  double precision;
    v         public.vuelo_aviator;
begin
    if v_uid is null then
        raise exception 'NO_AUTENTICADO';
    end if;

    -- 1) usuario, 2) vuelo
    select tokens into v_saldo from public.usuario where id_usuario = v_uid for update;
    if not found then
        raise exception 'PERFIL_NO_ENCONTRADO';
    end if;

    select * into v from public.vuelo_aviator
     where id_vuelo = p_id_vuelo and id_usuario = v_uid
       for update;
    if not found then
        raise exception 'VUELO_NO_ENCONTRADO';
    end if;

    if v.estado <> 'en_vuelo' then
        return public.aviator_aux_vista(v, v_saldo) || jsonb_build_object('ya_terminado', true);
    end if;

    v_t      := public.aviator_aux_segundos(v.inicio);
    v_m_real := public.aviator_aux_multiplicador(v_t);
    v_m_clic := public.aviator_aux_multiplicador(v_t - (v_cfg ->> 'margen_segundos')::double precision);

    if v.multiplicador_crash is not null and v_m_clic >= v.multiplicador_crash then
        -- Ya había cruzado la tormenta fatal: cae.
        perform public.aviator_aux_caer(v.id_vuelo);
    elsif v_m_real >= (v_cfg ->> 'maximo')::double precision then
        -- Llegó al máximo antes de que llegara el clic: se paga el máximo.
        perform public.aviator_aux_pagar(v.id_vuelo, (v_cfg ->> 'maximo')::numeric);
    else
        perform public.aviator_aux_pagar(v.id_vuelo, public.aviator_aux_dos_decimales(v_m_clic));
    end if;

    select * into v from public.vuelo_aviator where id_vuelo = v.id_vuelo;
    select tokens into v_saldo from public.usuario where id_usuario = v_uid;
    return public.aviator_aux_vista(v, v_saldo);
end;
$$;


-- ---------------------------------------------------------------------
-- aviator_vuelo_actual: para reanudar al recargar la página.
-- Si el avión cayó (o llegó al máximo) mientras tanto, lo resuelve y lo
-- devuelve ya terminado con "reanudado": true. Si no hay vuelo:
-- {"estado": "sin_vuelo", "saldo": ..., "tormentas": [posiciones]}.
-- ---------------------------------------------------------------------
create or replace function public.aviator_vuelo_actual()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid    uuid := auth.uid();
    v_saldo  integer;
    v        public.vuelo_aviator;
begin
    if v_uid is null then
        raise exception 'NO_AUTENTICADO';
    end if;

    -- 1) usuario, 2) vuelo
    select tokens into v_saldo from public.usuario where id_usuario = v_uid for update;
    if not found then
        raise exception 'PERFIL_NO_ENCONTRADO';
    end if;

    select * into v from public.vuelo_aviator
     where id_usuario = v_uid and estado = 'en_vuelo'
       for update;
    if not found then
        -- Sin vuelo: se mandan las POSICIONES (públicas) para dibujar el mapa,
        -- nunca si son fatales (todavía no se han sorteado).
        return jsonb_build_object(
            'estado',    'sin_vuelo',
            'saldo',     v_saldo,
            'velocidad', (public.aviator_aux_config() ->> 'velocidad')::numeric,
            'maximo',    (public.aviator_aux_config() ->> 'maximo')::numeric,
            'tormentas', (select jsonb_agg(jsonb_build_object('m', m::numeric, 'cruzada', false, 'fatal', null)
                                           order by ord)
                            from jsonb_array_elements_text(public.aviator_aux_config() -> 'tormentas')
                                 with ordinality as t(m, ord))
        );
    end if;

    perform public.aviator_aux_resolver(v.id_vuelo);

    select * into v from public.vuelo_aviator where id_vuelo = v.id_vuelo;
    select tokens into v_saldo from public.usuario where id_usuario = v_uid;
    return public.aviator_aux_vista(v, v_saldo) || jsonb_build_object('reanudado', true);
end;
$$;


-- =====================================================================
-- Permisos
-- Supabase da EXECUTE por defecto a anon y authenticated sobre funciones
-- nuevas en "public", así que hay que quitarlo explícitamente.
-- =====================================================================

-- Auxiliares: nadie desde el navegador.
revoke execute on function public.aviator_aux_config()                                from public, anon, authenticated;
revoke execute on function public.aviator_aux_segundos(timestamptz)                   from public, anon, authenticated;
revoke execute on function public.aviator_aux_multiplicador(double precision)         from public, anon, authenticated;
revoke execute on function public.aviator_aux_dos_decimales(double precision)         from public, anon, authenticated;
revoke execute on function public.aviator_aux_azar(bigint)                            from public, anon, authenticated;
revoke execute on function public.aviator_aux_generar_tormentas()                     from public, anon, authenticated;
revoke execute on function public.aviator_aux_vista(public.vuelo_aviator, integer)    from public, anon, authenticated;
revoke execute on function public.aviator_aux_id_juego()                              from public, anon, authenticated;
revoke execute on function public.aviator_aux_caer(bigint)                            from public, anon, authenticated;
revoke execute on function public.aviator_aux_pagar(bigint, numeric)                  from public, anon, authenticated;
revoke execute on function public.aviator_aux_resolver(bigint)                        from public, anon, authenticated;

-- RPC del juego: solo usuarios con sesión iniciada.
revoke execute on function public.aviator_despegar(integer)  from public, anon;
revoke execute on function public.aviator_estado(bigint)     from public, anon;
revoke execute on function public.aviator_retirarse(bigint)  from public, anon;
revoke execute on function public.aviator_vuelo_actual()     from public, anon;

grant execute on function public.aviator_despegar(integer)  to authenticated;
grant execute on function public.aviator_estado(bigint)     to authenticated;
grant execute on function public.aviator_retirarse(bigint)  to authenticated;
grant execute on function public.aviator_vuelo_actual()     to authenticated;

commit;
