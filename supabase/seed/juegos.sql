-- Catálogo de juegos (datos iniciales).
-- En la base del equipo Blackjack ya existe (id_juego = 4); este archivo sirve
-- para entornos nuevos. Se puede ejecutar varias veces: nombre es UNIQUE y,
-- si el juego ya existe, no hace nada.

insert into public.juego (nombre, descripcion, imagen, ruta, estado)
values ('Blackjack', 'Acércate a 21 sin pasarte.', 'blackjack.png', '/juegos/blackjack', true)
on conflict (nombre) do nothing;
