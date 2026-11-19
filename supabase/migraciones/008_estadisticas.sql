-- =====================================================================
-- 008_estadisticas.sql
-- Función de SOLO LECTURA con el resumen de partidas del jugador.
--
-- Por qué en el servidor y no en el navegador:
--   * Para el resumen hay que recorrer TODAS las partidas del jugador.
--     Traerlas al navegador crece sin límite (mil partidas = mil filas por
--     cada visita) y además PostgREST corta las respuestas en 1000 filas,
--     así que el cálculo saldría mal con jugadores muy activos.
--   * Aquí Postgres agrega con count/sum y devuelve un solo JSON pequeño.
--
-- SECURITY INVOKER (lo normal, no se escribe): corre con los permisos del
-- propio usuario, así que las políticas RLS de "partida" y "juego" siguen
-- aplicando. No necesita permisos extra porque solo lee lo que el usuario
-- ya puede leer. Además filtra por auth.uid() de forma explícita.
--
-- No modifica nada: es STABLE y solo hace SELECT.
-- =====================================================================

begin;

create or replace function public.mis_estadisticas()
returns jsonb
language sql
stable
set search_path = public
as $$
    with mias as (
        select p.id_juego, p.apuesta, p.premio, p.resultado
        from public.partida p
        where p.id_usuario = auth.uid()
    ),
    por_juego as (
        select m.id_juego,
               coalesce(j.nombre, 'Juego #' || m.id_juego)                  as nombre,
               count(*)                                                     as partidas,
               count(*) filter (where m.resultado = 'GANADA')               as ganadas,
               coalesce(sum(m.premio), 0)::bigint - coalesce(sum(m.apuesta), 0)::bigint as balance
        from mias m
        left join public.juego j on j.id_juego = m.id_juego
        group by m.id_juego, j.nombre
    )
    select jsonb_build_object(
        'partidas',  (select count(*) from mias),
        'ganadas',   (select count(*) from mias where resultado = 'GANADA'),
        'perdidas',  (select count(*) from mias where resultado = 'PERDIDA'),
        'empates',   (select count(*) from mias where resultado = 'EMPATE'),
        'apostado',  (select coalesce(sum(apuesta), 0)::bigint from mias),
        'ganado',    (select coalesce(sum(premio), 0)::bigint from mias),
        'balance',   (select coalesce(sum(premio), 0)::bigint - coalesce(sum(apuesta), 0)::bigint from mias),
        -- Juego más jugado; si hay empate, el de nombre alfabéticamente primero.
        'favorito',  (select nombre from por_juego order by partidas desc, nombre limit 1),
        'por_juego', coalesce(
            (select jsonb_agg(jsonb_build_object(
                        'id_juego', id_juego,
                        'nombre',   nombre,
                        'partidas', partidas,
                        'ganadas',  ganadas,
                        'balance',  balance)
                    order by partidas desc, nombre)
             from por_juego),
            '[]'::jsonb)
    );
$$;

-- Supabase da EXECUTE por defecto a anon; solo la usan usuarios con sesión.
revoke execute on function public.mis_estadisticas() from public, anon;
grant  execute on function public.mis_estadisticas() to authenticated;

commit;
