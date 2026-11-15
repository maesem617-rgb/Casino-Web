
import { supabase } from "./supabase.js";

const formulario = document.getElementById("formLogin");
const mensaje = document.getElementById("mensaje");
const botonEntrar = formulario.querySelector('button[type="submit"]');

formulario.addEventListener("submit", async (event) => {
    event.preventDefault();

    const correo = document.getElementById("correo").value.trim();
    const clave = document.getElementById("clave").value;

    if (!correo || !clave) {
        mensaje.textContent = "Completa todos los campos.";
        return;
    }

    botonEntrar.disabled = true;
    mensaje.textContent = "Verificando usuario...";

    try {
        const { data, error } =
            await supabase.auth.signInWithPassword({
                email: correo,
                password: clave
            });

        if (error) {
            mensaje.textContent =
                "Correo o contraseña incorrectos.";
            return;
        }

        if (data.user) {
            window.location.replace("index.html");
        }
    } catch (error) {
        console.error(error);
        mensaje.textContent =
            "No se pudo conectar con Supabase.";
    } finally {
        botonEntrar.disabled = false;
    }
});
