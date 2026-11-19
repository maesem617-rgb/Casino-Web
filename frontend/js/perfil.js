// "Perfil": muestra los datos del jugador y permite editar SOLO nombre y username.
//   * La edición pasa por la función actualizar_perfil del servidor
//     (supabase/migraciones/009_perfil.sql), que nunca toca tokens ni correo.
//   * Las validaciones de aquí son solo para avisar rápido; quien decide es el
//     servidor, que vuelve a validar todo.
//   * La contraseña se cambia con supabase.auth.updateUser({ password }).

import { supabase } from "./supabase.js";
import { prepararBarra, pintarBarra, cerrarSesion, formatear } from "./barra.js";

const $ = (id) => document.getElementById(id);

const barra = { saldo: $("pfSaldo"), usuario: $("pfUsuario"), salir: $("pfSalirBarra") };

const el = {
    avatar: $("pfAvatar"),
    nombre: $("pfNombre"),
    username: $("pfUsername"),
    correo: $("pfCorreo"),
    miembro: $("pfMiembro"),
    tokens: $("pfTokens"),
    partidas: $("pfPartidas"),
    porcentaje: $("pfPorcentaje"),
    balance: $("pfBalance"),
    formPerfil: $("pfFormPerfil"),
    inputNombre: $("pfInputNombre"),
    inputUsername: $("pfInputUsername"),
    inputCorreo: $("pfInputCorreo"),
    guardar: $("pfGuardar"),
    mensajePerfil: $("pfMensajePerfil"),
    formClave: $("pfFormClave"),
    inputClave: $("pfInputClave"),
    inputConfirmar: $("pfInputConfirmar"),
    cajaCodigo: $("pfCajaCodigo"),
    inputCodigo: $("pfInputCodigo"),
    enviarCodigo: $("pfEnviarCodigo"),
    cambiarClave: $("pfCambiarClave"),
    mensajeClave: $("pfMensajeClave")
};

// Mismas reglas que en el servidor (solo para avisar antes de enviar).
const REGEX_USERNAME = /^[A-Za-z0-9_]{3,20}$/;

const MENSAJES_PERFIL = {
    NO_AUTENTICADO: "Tu sesión expiró. Inicia sesión de nuevo.",
    NOMBRE_INVALIDO: "El nombre debe tener de 1 a 60 caracteres, sin espacios al inicio ni al final.",
    USERNAME_INVALIDO: "El username debe tener de 3 a 20 caracteres: solo letras sin acento, números y guion bajo.",
    USERNAME_OCUPADO: "Ese username ya lo usa otro jugador. Prueba con otro.",
    PERFIL_NO_ENCONTRADO: "No se encontró tu perfil de jugador."
};

function mensaje(nodo, texto, tipo) {
    nodo.textContent = texto;
    nodo.classList.remove("pf-ok", "pf-mal");
    if (tipo) nodo.classList.add(tipo === "ok" ? "pf-ok" : "pf-mal");
}

// ===== Pintar perfil =====
function pintarPerfil(perfil) {
    el.avatar.textContent = (perfil.username?.[0] ?? "?").toUpperCase();
    el.nombre.textContent = perfil.nombre || perfil.username;
    el.username.textContent = perfil.username;
    el.correo.textContent = perfil.correo;
    el.tokens.textContent = formatear(perfil.tokens);
    if (perfil.fecha_registro) {
        const fecha = new Date(perfil.fecha_registro).toLocaleDateString("es-MX", { dateStyle: "long" });
        el.miembro.textContent = `Miembro desde el ${fecha}`;
    }
    el.inputNombre.value = perfil.nombre ?? "";
    el.inputUsername.value = perfil.username;
    el.inputCorreo.value = perfil.correo;
    pintarBarra(barra, perfil);
}

async function cargarEstadisticas() {
    const { data, error } = await supabase.rpc("mis_estadisticas");
    if (error) {
        console.error("Error en mis_estadisticas:", error.message);
        return;
    }
    el.partidas.textContent = formatear(data.partidas);
    el.porcentaje.textContent = data.partidas > 0
        ? `${Math.round((data.ganadas / data.partidas) * 100)} %`
        : "—";
    const balance = Number(data.balance) || 0;
    el.balance.textContent = balance > 0 ? `+${formatear(balance)}` : balance < 0 ? `−${formatear(-balance)}` : "0";
    el.balance.classList.toggle("pf-verde", balance > 0);
    el.balance.classList.toggle("pf-rojo", balance < 0);
}

// ===== Editar nombre y username =====
async function guardarPerfil(event) {
    event.preventDefault();
    const nombre = el.inputNombre.value.trim(); // quitamos espacios de los extremos
    const username = el.inputUsername.value.trim();

    if (nombre.length < 1 || nombre.length > 60) {
        mensaje(el.mensajePerfil, MENSAJES_PERFIL.NOMBRE_INVALIDO, "mal");
        return;
    }
    if (!REGEX_USERNAME.test(username)) {
        mensaje(el.mensajePerfil, MENSAJES_PERFIL.USERNAME_INVALIDO, "mal");
        return;
    }

    el.guardar.disabled = true;
    mensaje(el.mensajePerfil, "Guardando…");

    const { data, error } = await supabase.rpc("actualizar_perfil", {
        p_nombre: nombre,
        p_username: username
    });

    el.guardar.disabled = false;

    if (error) {
        const codigo = Object.keys(MENSAJES_PERFIL).find((c) => error.message?.includes(c));
        if (!codigo) console.error("Error en actualizar_perfil:", error);
        mensaje(el.mensajePerfil, codigo ? MENSAJES_PERFIL[codigo] : "Ocurrió un error inesperado. Intenta de nuevo.", "mal");
        return;
    }

    pintarPerfil(data); // la función devuelve el perfil actualizado
    mensaje(el.mensajePerfil, "¡Perfil actualizado!", "ok");
}

// ===== Cambiar contraseña =====
// Según la documentación de Supabase, updateUser necesita una sesión iniciada.
// Si en el proyecto está activada la opción de cambio de contraseña seguro,
// Supabase puede pedir reautenticación: reauthenticate() envía un código (OTP)
// al correo y ese código se manda como "nonce" en updateUser.
// La documentación no lista los códigos de error de este flujo, así que se
// detecta la reautenticación de forma tolerante (código o texto del mensaje).
function pideReautenticacion(error) {
    return error?.code === "reauthentication_needed" || /reauthenticat/i.test(error?.message ?? "");
}

async function enviarCodigo() {
    el.enviarCodigo.disabled = true;
    const { error } = await supabase.auth.reauthenticate();
    el.enviarCodigo.disabled = false;
    if (error) {
        console.error("Error en reauthenticate:", error);
        mensaje(el.mensajeClave, "No se pudo enviar el código. Espera un momento e intenta de nuevo.", "mal");
        return false;
    }
    el.cajaCodigo.hidden = false;
    mensaje(el.mensajeClave, "Por seguridad, te enviamos un código a tu correo. Escríbelo y pulsa «Cambiar contraseña».");
    el.inputCodigo.focus();
    return true;
}

async function cambiarClave(event) {
    event.preventDefault();
    const clave = el.inputClave.value;
    const confirmar = el.inputConfirmar.value;

    if (clave.length < 6) {
        mensaje(el.mensajeClave, "La contraseña debe tener al menos 6 caracteres.", "mal");
        return;
    }
    if (clave !== confirmar) {
        mensaje(el.mensajeClave, "Las contraseñas no coinciden.", "mal");
        return;
    }

    const codigo = el.inputCodigo.value.trim();
    if (!el.cajaCodigo.hidden && !codigo) {
        mensaje(el.mensajeClave, "Escribe el código que te enviamos al correo.", "mal");
        return;
    }

    el.cambiarClave.disabled = true;
    mensaje(el.mensajeClave, "Cambiando contraseña…");

    const cambios = { password: clave };
    if (codigo) cambios.nonce = codigo;
    const { error } = await supabase.auth.updateUser(cambios);

    el.cambiarClave.disabled = false;

    if (error) {
        if (pideReautenticacion(error) && el.cajaCodigo.hidden) {
            await enviarCodigo();
            return;
        }
        console.error("Error en updateUser:", error);
        let texto = "No se pudo cambiar la contraseña. Revisa los datos e intenta de nuevo.";
        if (error.code === "same_password") texto = "La contraseña nueva debe ser distinta a la actual.";
        else if (error.code === "weak_password") texto = "La contraseña es demasiado débil. Usa una más larga o variada.";
        else if (codigo) texto = "El código no es válido o ya expiró. Pide uno nuevo.";
        mensaje(el.mensajeClave, texto, "mal");
        return;
    }

    el.formClave.reset();
    el.cajaCodigo.hidden = true;
    mensaje(el.mensajeClave, "¡Contraseña cambiada correctamente!", "ok");
}

// ===== Inicio =====
async function iniciar() {
    const sesion = await prepararBarra(barra);
    if (!sesion) return; // redirigiendo a login

    $("pfSalir").addEventListener("click", cerrarSesion);
    el.formPerfil.addEventListener("submit", guardarPerfil);
    el.formClave.addEventListener("submit", cambiarClave);
    el.enviarCodigo.addEventListener("click", enviarCodigo);

    if (sesion.perfil) {
        pintarPerfil(sesion.perfil);
    } else {
        el.nombre.textContent = "No se pudo cargar tu perfil";
    }
    cargarEstadisticas();
}

iniciar();
