# CLAUDE.md — Casino Virtual

> Punto de entrada del proyecto para personas e IAs. Claude Code lo carga en cada sesión.
> Con otra IA (ChatGPT, Gemini, Copilot…): pega este archivo y los documentos del índice que apliquen a la tarea.
> Cualquier cambio a la documentación entra por Pull Request, igual que el código.

## Qué es

**Casino Virtual**: aplicación web que simula un casino con **tokens virtuales**. El usuario se registra, recibe tokens iniciales y los usa para jugar; según el resultado de cada partida gana o pierde tokens. Descripción general en [README.md](README.md).

**Objetivo:** un usuario puede registrarse, iniciar sesión, jugar a varios juegos de casino y consultar su saldo e historial, con tokens que **solo el servidor** puede modificar.

Proyecto académico universitario. **No usa dinero real**: no hay depósitos, retiros ni apuestas con valor monetario, y nunca los habrá.

## Stack

- **Frontend:** HTML, CSS y JavaScript.
- **Datos y autenticación:** Supabase (PostgreSQL + Supabase Auth).
- **Lógica de apuestas:** funciones en Supabase que se ejecutan en el servidor, nunca en el navegador.
- **Control de versiones:** Git y GitHub (repositorio + GitHub Projects para tareas).

No agregues librerías ni servicios nuevos sin justificarlo en el PR.

## Estructura

```text
Casino-Web/
├── frontend/          Páginas, estilos, scripts e imágenes
│   ├── css/
│   ├── js/
│   ├── img/
│   └── juegos/        Una carpeta por juego (tragamonedas, ruleta, blackjack, dados, cara-o-cruz)
├── supabase/
│   ├── migraciones/   Cambios a la base de datos, numerados y en orden
│   ├── funciones/     Lógica de apuestas y tokens que corre en el servidor
│   └── seed/          Datos iniciales (catálogo de juegos, usuarios de prueba)
├── docs/              Documentación (ver índice)
├── .env.example       Nombres de las variables de entorno, sin valores reales
├── CLAUDE.md
├── README.md
└── .gitignore
```

Si la estructura cambia, se actualiza aquí y en el índice en el mismo PR.

## Base de datos

Tablas principales: `usuario`, `juego`, `partida` y `movimiento_token` (detalle en [docs/documentacion_base_datos.pdf](docs/documentacion_base_datos.pdf)).

- Las contraseñas las guarda **Supabase Auth**; la tabla `usuario` funciona como perfil (nombre, username, tokens, fecha de registro) y se enlaza con el usuario de Auth.
- **Todo cambio de saldo** genera un registro en `movimiento_token` (APUESTA, PREMIO, BONO INICIAL…).
- Nadie modifica tablas directo desde el panel de Supabase: todo cambio va en una migración y se avisa al equipo.

## Reglas de oro

1. **Los tokens los calcula el servidor.** El navegador nunca modifica el saldo ni decide si alguien ganó.
2. **El resultado de cada juego se decide en el servidor.** El frontend solo muestra la animación y el resultado que recibió.
3. **Row Level Security activado en todas las tablas.** Cada usuario solo puede leer sus propios datos.
4. **No se puede apostar más tokens de los que se tienen**, ni apuestas en cero o negativas.
5. **Tokens como números enteros**, nunca decimales.
6. **Secretos solo en variables de entorno.** La llave `service_role` de Supabase **jamás** se sube al repo ni se usa en el frontend.
7. **Nada de dinero real**: ninguna funcionalidad de pagos, depósitos o retiros.

**Nombres:** en español y sin acentos ni ñ en identificadores (`apostar`, `saldo`, `partida`). Tablas y columnas en `snake_case`; variables y funciones de JavaScript en `camelCase`. Textos visibles al usuario en español.

## Equipo

| Nombre     | Rol / área principal                          |
| ---------- | --------------------------------------------- |
| [Nombre 1] | Dueño del repo y de Supabase · [área]         |
| [Nombre 2] | [área]                                        |

Las tareas viven en el tablero de **GitHub Projects** con columnas: Por hacer · En proceso · En revisión · Terminado.

## Git

- `main` está protegida: **nadie hace push directo**.
- Una rama por tarea: `feat/login`, `feat/juego-ruleta`, `fix/saldo-negativo`, `docs/base-de-datos`.
- Commits claros en español: `feat: agregar historial de partidas`, `fix: validar apuesta mayor al saldo`.
- PR pequeños, con descripción de qué cambia y cómo probarlo, enlazados a su tarea del tablero.
- **Cada PR necesita la aprobación de otro integrante** que no sea el autor antes de fusionarse.
- Fusiona a `main`: [Nombre]. Después de fusionar se borra la rama.

## Documentación

1. Fuente única: cada dato vive en un solo archivo; los demás enlazan, no copian.
2. Se describe cómo es el sistema, no bitácoras. Lo que está en progreso vive en el tablero.
3. Este archivo no debe pasar de 120 líneas.
4. Decisiones importantes (tecnologías, cambios de diseño) se registran en `docs/decisiones.md`.

## Instrucciones para la IA

1. Si no te lo dijeron, **pregunta en qué tarea se trabaja** y quién la tiene asignada.
2. Limítate al alcance de esa tarea. Nada de cambios en otras áreas sin avisar.
3. Antes de escribir código, propón un plan corto y espera confirmación en cambios grandes.
4. Respeta las reglas de oro, en especial: **los tokens y los resultados los decide el servidor**.
5. No agregues librerías sin explicar por qué y qué alternativas hay.
6. No inventes funciones de Supabase: consulta la documentación oficial o di que no estás seguro.
7. Nunca escribas llaves ni contraseñas en el código ni en commits.
8. Al terminar, resume qué cambió, cómo probarlo y qué quedó pendiente; sugiere mensaje de commit.
9. Si detectas una decisión de diseño que no te corresponde, detente y repórtala.
10. Explica en español y de forma clara: el equipo está aprendiendo, la explicación importa tanto como el código.

