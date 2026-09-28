# 🎰 Casino Virtual

Casino Virtual es una aplicación web desarrollada como proyecto académico. Su objetivo es simular el funcionamiento básico de una plataforma de casino mediante **tokens virtuales**, sin utilizar dinero real.

Los usuarios podrán crear una cuenta, recibir tokens dentro de la plataforma y utilizarlos para participar en diferentes juegos. Dependiendo del resultado de cada partida, el usuario podrá ganar o perder tokens.

> ⚠️ Este proyecto tiene fines exclusivamente educativos. No utiliza dinero real ni permite realizar depósitos, retiros o apuestas con valor monetario.

## 🎯 Objetivo del proyecto

Desarrollar una aplicación web que permita aplicar conceptos de:

- Desarrollo web.
- Frontend y backend.
- Bases de datos.
- Autenticación de usuarios.
- Manejo de sesiones.
- APIs.
- Lógica de juegos.
- Control de transacciones con tokens.
- Git y GitHub para control de versiones.

## 🎮 Funcionamiento general

El usuario podrá registrarse e iniciar sesión en la plataforma.

Al crear una cuenta recibirá una cantidad inicial de **tokens virtuales**.

Estos tokens podrán utilizarse para jugar dentro del casino.

El funcionamiento general será:

`Usuario → Selecciona juego → Realiza apuesta → Se ejecuta partida → Obtiene resultado → Se actualizan tokens`

Los tokens solamente existen dentro de la aplicación y **no tienen valor monetario real**.

## 🕹️ Juegos

El proyecto contará con diferentes juegos de casino.

Inicialmente se contempla desarrollar juegos sencillos como:

- 🎰 Tragamonedas
- 🎡 Ruleta
- 🃏 Blackjack
- 🎲 Dados
- 🪙 Cara o cruz

La cantidad de juegos puede cambiar durante el desarrollo del proyecto.

Los juegos podrán desarrollarse directamente utilizando tecnologías web o integrarse mediante servicios externos si se encuentra una alternativa adecuada para el proyecto.

## 🗄️ Base de datos

La primera versión de la base de datos está compuesta por cuatro tablas principales:

### USUARIO

Almacena la información de las cuentas registradas.

Entre sus datos se encuentran:

- Identificador del usuario.
- Nombre.
- Nombre de usuario.
- Correo electrónico.
- Contraseña protegida mediante hash.
- Cantidad actual de tokens.
- Fecha de registro.

### JUEGO

Contiene el catálogo de juegos disponibles en la plataforma.

Almacena información como:

- Identificador del juego.
- Nombre.
- Descripción.
- Imagen.
- Ruta para acceder al juego.
- Estado del juego.

### PARTIDA

Registra cada partida realizada dentro del casino.

Relaciona al usuario con el juego utilizado y almacena:

- Usuario.
- Juego.
- Tokens apostados.
- Premio obtenido.
- Resultado.
- Fecha y hora.

Esto permite generar posteriormente un historial de partidas para cada usuario.

### MOVIMIENTO_TOKEN

Registra todos los cambios realizados en el saldo de tokens de un usuario.

Por ejemplo:

`APUESTA → -100 tokens`

`PREMIO → +300 tokens`

Esto permite conocer no solamente cuántos tokens tiene actualmente un usuario, sino también **por qué aumentó o disminuyó su saldo**.

## 🔗 Relaciones principales

La base de datos utiliza las siguientes relaciones:

`USUARIO 1 ─── N PARTIDA`

Un usuario puede realizar muchas partidas.

`JUEGO 1 ─── N PARTIDA`

Un juego puede aparecer en muchas partidas.

`USUARIO 1 ─── N MOVIMIENTO_TOKEN`

Un usuario puede tener muchos movimientos de tokens.

`PARTIDA 1 ─── N MOVIMIENTO_TOKEN`

Una partida puede generar diferentes movimientos, como una apuesta y posteriormente un premio.

## 💰 Sistema de tokens

Los tokens funcionan como la moneda ficticia del casino.

Ejemplo:

Usuario inicia con:

`1000 tokens`

Realiza una apuesta:

`-100 tokens`

Saldo:

`900 tokens`

Obtiene un premio:

`+300 tokens`

Saldo final:

`1200 tokens`

Cada uno de estos movimientos puede quedar registrado en la base de datos.

## 🔐 Seguridad

Algunas consideraciones importantes para el proyecto son:

- Las contraseñas no deben almacenarse en texto plano.
- Las apuestas deben validarse desde el backend.
- Un usuario no puede apostar más tokens de los que posee.
- El navegador no debe poder modificar directamente el saldo.
- Las operaciones relacionadas con partidas y tokens deben validarse antes de almacenarse.

## 🛠️ Tecnologías

Las tecnologías definitivas se irán estableciendo durante el desarrollo.

Inicialmente se contempla utilizar:

**Frontend**
- HTML
- CSS
- JavaScript

**Base de datos**
- MySQL

**Control de versiones**
- Git
- GitHub

**Backend**
- Por definir

## 📁 Estructura del proyecto

La estructura definitiva se irá modificando conforme avance el desarrollo.

Una posible organización inicial es:

```text
Casino-Web/
│
├── frontend/
│   ├── css/
│   ├── js/
│   ├── img/
│   └── juegos/
│
├── backend/
│
├── database/
│   └── casino_virtual.sql
│
├── docs/
│   └── documentacion_base_datos.pdf
│
├── README.md
└── .gitignore
```

## 🚧 Estado del proyecto

Actualmente el proyecto se encuentra en etapa de diseño y desarrollo inicial.

Se está trabajando principalmente en:

- Diseño de la base de datos.
- Arquitectura del proyecto.
- Sistema de usuarios.
- Sistema de tokens.
- Selección y desarrollo de los juegos.

## 📚 Propósito académico

Este proyecto se desarrolla como parte de una materia universitaria y tiene como objetivo poner en práctica los conocimientos adquiridos durante el curso.

El sistema simula un casino únicamente mediante tokens virtuales y **no está diseñado para realizar apuestas con dinero real**.
