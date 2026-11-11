// ===== Casino Virtual · Página de inicio de sesión =====
// Por ahora solo valida el formulario en el navegador.
// La autenticación real se hará con Supabase Auth cuando esté configurado
// (la validación del navegador es solo para ayudar al usuario, no es seguridad).

const formLogin = document.getElementById("formLogin");
const inputCorreo = document.getElementById("correo");
const inputClave = document.getElementById("clave");
const botonVerClave = document.getElementById("verClave");
const mensaje = document.getElementById("mensaje");

// Mostrar u ocultar la contraseña
botonVerClave.addEventListener("click", () => {
  const oculta = inputClave.type === "password";
  inputClave.type = oculta ? "text" : "password";
  botonVerClave.textContent = oculta ? "Ocultar" : "Ver";
  botonVerClave.setAttribute("aria-label", oculta ? "Ocultar contraseña" : "Mostrar contraseña");
});

function mostrarMensaje(texto, esExito = false) {
  mensaje.textContent = texto;
  mensaje.classList.toggle("ok", esExito);
}

function validarFormulario() {
  inputCorreo.classList.remove("error");
  inputClave.classList.remove("error");

  const correo = inputCorreo.value.trim();
  const clave = inputClave.value;

  if (!correo || !inputCorreo.checkValidity()) {
    inputCorreo.classList.add("error");
    return "Escribe un correo electrónico válido.";
  }
  if (clave.length < 6) {
    inputClave.classList.add("error");
    return "La contraseña debe tener al menos 6 caracteres.";
  }
  return null;
}

formLogin.addEventListener("submit", (evento) => {
  evento.preventDefault();

  const error = validarFormulario();
  if (error) {
    mostrarMensaje(error);
    return;
  }

  // PENDIENTE: iniciar sesión con Supabase Auth y redirigir a index.html.
  mostrarMensaje("Formulario válido. La conexión con Supabase está pendiente.", true);
});
