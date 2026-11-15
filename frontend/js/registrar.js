
import { supabase } from "./supabase.js";

const formulario = document.getElementById("formRegistro");
const mensaje = document.getElementById("mensaje");
const boton = formulario.querySelector('button[type="submit"]');

formulario.addEventListener("submit", async (event) => {
    event.preventDefault();

    const nombre = document.getElementById("nombre").value.trim();
    const username = document.getElementById("username").value.trim();
    const correo = document.getElementById("correo").value.trim();
    const clave = document.getElementById("clave").value;
    const confirmar = document.getElementById("confirmarClave").value;

    if (!nombre || !username || !correo || !clave || !confirmar) {
        mensaje.textContent = "Completa todos los campos.";
        return;
    }

    if (clave.length < 6) {
        mensaje.textContent =
            "La contraseña debe tener al menos 6 caracteres.";
        return;
    }

    if (clave !== confirmar) {
        mensaje.textContent = "Las contraseñas no coinciden.";
        return;
    }

    boton.disabled = true;
    mensaje.textContent = "Creando cuenta...";

    try {
        const { data, error } = await supabase.auth.signUp({
            email: correo,
            password: clave,
            options: {
                data: {
                    nombre: nombre,
                    username: username
                }
            }
        });

        if (error) {
            console.error("Error al registrar:", error.message);
            mensaje.textContent = error.message;
            return;
        }

        if (!data.user) {
            mensaje.textContent =
                "No se pudo completar el registro.";
            return;
        }

        if (data.session) {
            mensaje.textContent = "¡Cuenta creada correctamente!";
            window.location.replace("index.html");
        } else {
            mensaje.textContent =
                "Cuenta registrada. Si se requiere confirmación, revisa tu correo.";
        }

    } catch (error) {
        console.error("Error de conexión:", error);
        mensaje.textContent =
            "Ocurrió un error al conectar con Supabase.";
    } finally {
        boton.disabled = false;
    }
});
