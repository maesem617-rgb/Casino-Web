// Lógica compartida de la barra superior para las páginas que exigen sesión
// (partidas.html y perfil.html): comprueba la sesión, muestra saldo y username
// y conecta el botón "Cerrar sesión". Solo LEE el perfil; nunca lo modifica.

import { supabase } from "./supabase.js";

export function formatear(numero) {
    return Number(numero).toLocaleString("es-MX");
}

// elementos: { saldo, usuario, salir } (los ids los pone cada página).
// Devuelve { user, perfil } o redirige a login.html si no hay sesión.
export async function prepararBarra(elementos) {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
        window.location.replace("login.html");
        return null;
    }

    elementos.salir.addEventListener("click", cerrarSesion);

    const { data: perfil, error: errorPerfil } = await supabase
        .from("usuario")
        .select("nombre, username, correo, tokens, fecha_registro")
        .eq("id_usuario", data.user.id)
        .single();

    if (errorPerfil) {
        console.error("Error al obtener el perfil:", errorPerfil.message);
        elementos.saldo.textContent = "—";
        return { user: data.user, perfil: null };
    }

    pintarBarra(elementos, perfil);
    return { user: data.user, perfil };
}

export function pintarBarra(elementos, perfil) {
    elementos.saldo.textContent = formatear(perfil.tokens);
    elementos.usuario.textContent = perfil.username;
}

export async function cerrarSesion(event) {
    event?.preventDefault();
    const { error } = await supabase.auth.signOut();
    if (error) {
        console.error("Error al cerrar sesión:", error.message);
        return;
    }
    window.location.replace("login.html");
}
