Aquí están las actividades con sus criterios de aceptación, agrupadas por etapa para que se vea el orden en que conviene hacerlas.

## Etapa 1: Base

**1. Configurar Supabase**
- Existe el proyecto en Supabase y ambos integrantes tienen acceso.
- Las claves privadas no están en el repositorio.

**2. Crear la base de datos**
- Existen las tablas usuario, juego, partida y movimiento_token con sus relaciones.
- Row Level Security está activado en todas las tablas.
- El catálogo tiene cargados los 4 juegos.

**3. Registro de usuario**
- El usuario puede crear una cuenta con nombre, username, correo y contraseña.
- No se permiten correos ni usernames repetidos.
- Se muestran mensajes claros cuando hay un error.

**4. Inicio y cierre de sesión**
- El usuario puede iniciar sesión con correo y contraseña.
- La sesión se mantiene al recargar la página.
- El usuario puede cerrar sesión.
- Las páginas del casino no se pueden ver sin iniciar sesión.

**5. Tokens iniciales**
- Al crear la cuenta, el usuario recibe 1000 tokens.
- Queda registrado un movimiento de tipo BONO INICIAL.

**6. Diseño visual general

- Hay una paleta de colores y tipografía definidas y se usan en todas las páginas.
- La página se ve bien en pantallas de computadora (por ejemplo, de 1366 px de ancho en adelante).

**7. Página de inicio**
- Explica qué es el casino y que no usa dinero real.
- Tiene botones para registrarse e iniciar sesión.

**8. Catálogo de juegos**
- Muestra los juegos disponibles con nombre, imagen y descripción.
- Al hacer clic en un juego, lleva a su página.

**9. Barra superior con saldo**
- Muestra el username y el saldo actual en todas las páginas del casino.
- El saldo se actualiza después de cada partida sin recargar la página.

## Etapa 2: Flujo de apuesta

**10. Flujo de apuesta (con Cara o cruz)**
- El usuario elige cara o cruz y la cantidad a apostar.
- El resultado lo decide el servidor, no el navegador.
- No se puede apostar más de lo que se tiene, ni cero o cantidades negativas.
- Si gana, recibe el doble de lo apostado.
- Se guarda la partida y sus movimientos (APUESTA y, si aplica, PREMIO).
- El saldo no se puede modificar desde la consola del navegador.

## Etapa 3: Juegos

**11. Dados**
- El usuario apuesta y elige a qué resultado apostar.
- Se muestra una animación de los dados antes del resultado.
- El pago corresponde a las reglas definidas para el juego.
- Cumple los mismos criterios de seguridad que la actividad 10.

**12. Ruleta**
- El usuario puede apostar a número, color y par/impar.
- Cada tipo de apuesta paga lo que corresponde según sus reglas.
- Se muestra la animación del giro antes del resultado.
- Cumple los mismos criterios de seguridad que la actividad 10.

**13. Blackjack**
- El usuario apuesta antes de recibir sus cartas.
- Puede pedir carta o plantarse.
- El crupier juega según reglas fijas (por ejemplo, pide hasta llegar a 17).
- Se manejan correctamente victoria, derrota, empate y blackjack natural.
- Las cartas se reparten desde el servidor y no se pueden ver ni alterar desde el navegador.

## Etapa 4: Cierre

**14. Historial de partidas**
- El usuario ve sus partidas con juego, apuesta, premio, resultado y fecha.
- Solo puede ver sus propias partidas.

**15. Perfil de usuario**
- Muestra datos del usuario, saldo actual y estadísticas básicas (partidas jugadas, ganadas y perdidas).

**16. Pruebas de seguridad**
- Se comprobó que no se puede apostar más del saldo.
- Se comprobó que no se puede modificar el saldo ni el resultado desde el navegador.
- Se comprobó que un usuario no puede ver datos de otro.

**17. Documentación final**
- El README describe cómo funciona el proyecto y cómo correrlo.
- La documentación de la base de datos está actualizada.

Si quieres, lo paso a un documento para que lo tengan a la mano y lo puedan ir editando.
