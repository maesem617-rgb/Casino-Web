
import { supabase } from "./supabase.js";

const saldoTokens = document.getElementById("saldoTokens");
const enlaceLogin = document.getElementById("enlaceLogin");
const enlaceRegistro = document.getElementById("enlaceRegistro");

async function cargarUsuario() {
    try {
        // Comprobar si hay un usuario autenticado
        const { data, error } = await supabase.auth.getUser();

        if (error || !data.user) {
            saldoTokens.textContent = "—";
            return;
        }

        const usuario = data.user;

        // Consultar el perfil del jugador
        const { data: perfil, error: errorPerfil } = await supabase
            .from("usuario")
            .select("username, tokens")
            .eq("id_usuario", usuario.id)
            .single();

        if (errorPerfil) {
            console.error("Error al obtener perfil:", errorPerfil.message);
            saldoTokens.textContent = "—";
            return;
        }

        // Mostrar el saldo real de Supabase
        saldoTokens.textContent =
            Number(perfil.tokens).toLocaleString("es-MX");

        // Mostrar el nombre del jugador (enlaza a su perfil)
        enlaceLogin.textContent = perfil.username;
        enlaceLogin.href = "perfil.html";

        // Cambiar Registrarse por Cerrar sesión
        enlaceRegistro.textContent = "Cerrar sesión";
        enlaceRegistro.href = "#";

        enlaceRegistro.addEventListener("click", async (event) => {
            event.preventDefault();

            const { error } = await supabase.auth.signOut();

            if (error) {
                console.error("Error al cerrar sesión:", error.message);
                return;
            }

            window.location.replace("login.html");
        });

    } catch (error) {
        console.error("Error al cargar usuario:", error);
        saldoTokens.textContent = "—";
    }
}

cargarUsuario();
