// "Mis partidas": página de SOLO LECTURA.
//   * El resumen y el desglose por juego vienen de la función mis_estadisticas()
//     (supabase/migraciones/008_estadisticas.sql): el servidor agrega y manda un
//     JSON pequeño, en vez de traer todas las partidas al navegador.
//   * Las tablas de partidas y de movimientos se piden de 20 en 20 con .range().
//   * RLS garantiza que cada usuario solo recibe sus propias filas; además se
//     filtra por id_usuario de forma explícita.
// Todo el texto que viene de la base se pinta con textContent (nunca innerHTML).

import { supabase } from "./supabase.js";
import { prepararBarra, formatear } from "./barra.js";

const POR_PAGINA = 20;

const $ = (id) => document.getElementById(id);

const el = {
    cargando: $("ptCargando"),
    vacio: $("ptVacio"),
    resumen: $("ptResumen"),
    total: $("ptTotal"),
    ganadas: $("ptGanadas"),
    perdidas: $("ptPerdidas"),
    empates: $("ptEmpates"),
    porcentaje: $("ptPorcentaje"),
    apostado: $("ptApostado"),
    ganado: $("ptGanado"),
    balance: $("ptBalance"),
    favorito: $("ptFavorito"),
    porJuegoCaja: $("ptPorJuegoCaja"),
    porJuego: $("ptPorJuego"),
    detalle: $("ptDetalle"),
    tabPartidas: $("ptTabPartidas"),
    tabMovimientos: $("ptTabMovimientos"),
    panelPartidas: $("ptPanelPartidas"),
    panelMovimientos: $("ptPanelMovimientos"),
    filtroJuego: $("ptFiltroJuego"),
    filtroResultado: $("ptFiltroResultado"),
    filasPartidas: $("ptFilasPartidas"),
    partidasVacio: $("ptPartidasVacio"),
    error: $("ptError")
};

const TEXTO_RESULTADO = { GANADA: "Ganada", PERDIDA: "Perdida", EMPATE: "Empate" };
const TEXTO_TIPO = {
    APUESTA: "Apuesta", PREMIO: "Premio", REGISTRO: "Bono de registro",
    RECOMPENSA: "Recompensa", AJUSTE: "Ajuste"
};

let idUsuario = null;

// ===== Utilidades =====
function fecha(valor) {
    return new Date(valor).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
}

// Número con signo (+/−) y clase de color.
function conSigno(numero) {
    const n = Number(numero) || 0;
    const texto = n > 0 ? `+${formatear(n)}` : n < 0 ? `−${formatear(-n)}` : "0";
    const clase = n > 0 ? "pt-verde" : n < 0 ? "pt-rojo" : "";
    return { texto, clase };
}

function pintarConSigno(nodo, numero) {
    const { texto, clase } = conSigno(numero);
    nodo.textContent = texto;
    nodo.classList.remove("pt-verde", "pt-rojo");
    if (clase) nodo.classList.add(clase);
}

function porcentaje(parte, total) {
    return total > 0 ? Math.round((parte / total) * 100) : 0;
}

function celda(texto, clase) {
    const td = document.createElement("td");
    td.textContent = texto;
    if (clase) td.className = clase;
    return td;
}

function mostrarError(texto) {
    el.error.textContent = texto;
}

// ===== Resumen (servidor) =====
async function cargarResumen() {
    const { data, error } = await supabase.rpc("mis_estadisticas");
    el.cargando.hidden = true;

    if (error) {
        console.error("Error en mis_estadisticas:", error.message);
        mostrarError("No se pudieron cargar tus estadísticas. Intenta de nuevo más tarde.");
        return;
    }

    if (data.partidas === 0) {
        el.vacio.hidden = false;
        return;
    }

    el.total.textContent = formatear(data.partidas);
    el.ganadas.textContent = formatear(data.ganadas);
    el.perdidas.textContent = formatear(data.perdidas);
    el.empates.textContent = formatear(data.empates);
    el.porcentaje.textContent = `${porcentaje(data.ganadas, data.partidas)} % ganadas`;
    el.apostado.textContent = formatear(data.apostado);
    el.ganado.textContent = formatear(data.ganado);
    pintarConSigno(el.balance, data.balance);
    el.favorito.textContent = data.favorito ?? "—";
    el.resumen.hidden = false;

    el.porJuego.replaceChildren();
    for (const juego of data.por_juego) {
        const tarjeta = document.createElement("article");
        tarjeta.className = "pt-juego";

        const nombre = document.createElement("h4");
        nombre.textContent = juego.nombre;

        const datos = document.createElement("dl");
        const agregar = (titulo, valor, clase) => {
            const dt = document.createElement("dt");
            dt.textContent = titulo;
            const dd = document.createElement("dd");
            dd.textContent = valor;
            if (clase) dd.className = clase;
            datos.append(dt, dd);
        };
        const neto = conSigno(juego.balance);
        agregar("Partidas", formatear(juego.partidas));
        agregar("Ganadas", `${porcentaje(juego.ganadas, juego.partidas)} %`);
        agregar("Balance", neto.texto, neto.clase);

        tarjeta.append(nombre, datos);
        el.porJuego.append(tarjeta);
    }
    el.porJuegoCaja.hidden = data.por_juego.length === 0;
}

// ===== Tablas paginadas =====
// Crea un "paginador" reutilizable para las dos tablas.
function crearPaginador({ anterior, siguiente, etiqueta, cargar }) {
    const estado = { pagina: 0, total: 0 };
    const btnAnterior = $(anterior);
    const btnSiguiente = $(siguiente);
    const texto = $(etiqueta);

    function actualizarBotones() {
        const paginas = Math.max(1, Math.ceil(estado.total / POR_PAGINA));
        texto.textContent = `Página ${estado.pagina + 1} de ${paginas}`;
        btnAnterior.disabled = estado.pagina === 0;
        btnSiguiente.disabled = estado.pagina + 1 >= paginas;
    }

    async function ir(pagina) {
        estado.pagina = pagina;
        btnAnterior.disabled = btnSiguiente.disabled = true;
        // .range() usa índices inclusivos: página 0 → filas 0..19.
        const desde = pagina * POR_PAGINA;
        const hasta = desde + POR_PAGINA - 1;
        const total = await cargar(desde, hasta);
        if (total !== null) estado.total = total;
        actualizarBotones();
    }

    btnAnterior.addEventListener("click", () => ir(estado.pagina - 1));
    btnSiguiente.addEventListener("click", () => ir(estado.pagina + 1));
    return { ir };
}

async function cargarPartidas(desde, hasta) {
    let consulta = supabase
        .from("partida")
        .select("id_partida, fecha_hora, apuesta, premio, resultado, juego(nombre)", { count: "exact" })
        .eq("id_usuario", idUsuario)
        .order("fecha_hora", { ascending: false })
        .order("id_partida", { ascending: false }) // desempate estable entre páginas
        .range(desde, hasta);

    if (el.filtroJuego.value) consulta = consulta.eq("id_juego", Number(el.filtroJuego.value));
    if (el.filtroResultado.value) consulta = consulta.eq("resultado", el.filtroResultado.value);

    const { data, error, count } = await consulta;
    if (error) {
        console.error("Error al cargar partidas:", error.message);
        mostrarError("No se pudieron cargar tus partidas.");
        return null;
    }

    el.filasPartidas.replaceChildren();
    for (const p of data) {
        const fila = document.createElement("tr");
        const neto = conSigno(p.premio - p.apuesta);

        const tdResultado = document.createElement("td");
        const etiqueta = document.createElement("span");
        etiqueta.className = `pt-etiqueta pt-${p.resultado.toLowerCase()}`;
        etiqueta.textContent = TEXTO_RESULTADO[p.resultado] ?? p.resultado;
        tdResultado.append(etiqueta);

        fila.append(
            celda(fecha(p.fecha_hora)),
            celda(p.juego?.nombre ?? "—"),
            celda(formatear(p.apuesta)),
            celda(formatear(p.premio)),
            celda(neto.texto, neto.clase),
            tdResultado
        );
        el.filasPartidas.append(fila);
    }
    el.partidasVacio.hidden = data.length > 0;
    return count ?? 0;
}

async function cargarMovimientos(desde, hasta) {
    const { data, error, count } = await supabase
        .from("movimiento_token")
        .select("id_movimiento, fecha_hora, tipo, cantidad, saldo_anterior, saldo_nuevo", { count: "exact" })
        .eq("id_usuario", idUsuario)
        .order("fecha_hora", { ascending: false })
        .order("id_movimiento", { ascending: false })
        .range(desde, hasta);

    if (error) {
        console.error("Error al cargar movimientos:", error.message);
        mostrarError("No se pudieron cargar tus movimientos de tokens.");
        return null;
    }

    const cuerpo = $("ptFilasMovimientos");
    cuerpo.replaceChildren();
    for (const m of data) {
        const fila = document.createElement("tr");
        const cantidad = conSigno(m.cantidad); // la cantidad se guarda con signo
        fila.append(
            celda(fecha(m.fecha_hora)),
            celda(TEXTO_TIPO[m.tipo] ?? m.tipo),
            celda(cantidad.texto, cantidad.clase),
            celda(formatear(m.saldo_anterior)),
            celda(formatear(m.saldo_nuevo))
        );
        cuerpo.append(fila);
    }
    $("ptMovimientosVacio").hidden = data.length > 0;
    return count ?? 0;
}

// ===== Filtros (catálogo de juegos activos) =====
async function cargarFiltroJuegos() {
    const { data, error } = await supabase
        .from("juego")
        .select("id_juego, nombre")
        .order("nombre");
    if (error) {
        console.error("Error al cargar juegos:", error.message);
        return;
    }
    for (const juego of data) {
        const opcion = document.createElement("option");
        opcion.value = juego.id_juego;
        opcion.textContent = juego.nombre;
        el.filtroJuego.append(opcion);
    }
}

// ===== Pestañas =====
let movimientosCargados = false;

function elegirPestana(cual) {
    const esPartidas = cual === "partidas";
    el.tabPartidas.classList.toggle("activa", esPartidas);
    el.tabMovimientos.classList.toggle("activa", !esPartidas);
    el.tabPartidas.setAttribute("aria-selected", String(esPartidas));
    el.tabMovimientos.setAttribute("aria-selected", String(!esPartidas));
    el.panelPartidas.hidden = !esPartidas;
    el.panelMovimientos.hidden = esPartidas;

    // Los movimientos se piden la primera vez que se abre su pestaña.
    if (!esPartidas && !movimientosCargados) {
        movimientosCargados = true;
        paginadorMovimientos.ir(0);
    }
}

const paginadorPartidas = crearPaginador({
    anterior: "ptPartidasAnterior", siguiente: "ptPartidasSiguiente",
    etiqueta: "ptPartidasPagina", cargar: cargarPartidas
});
const paginadorMovimientos = crearPaginador({
    anterior: "ptMovimientosAnterior", siguiente: "ptMovimientosSiguiente",
    etiqueta: "ptMovimientosPagina", cargar: cargarMovimientos
});

// ===== Inicio =====
async function iniciar() {
    const sesion = await prepararBarra({ saldo: $("ptSaldo"), usuario: $("ptUsuario"), salir: $("ptSalir") });
    if (!sesion) return; // redirigiendo a login
    idUsuario = sesion.user.id;

    el.tabPartidas.addEventListener("click", () => elegirPestana("partidas"));
    el.tabMovimientos.addEventListener("click", () => elegirPestana("movimientos"));
    // Al cambiar un filtro se vuelve a la primera página.
    el.filtroJuego.addEventListener("change", () => paginadorPartidas.ir(0));
    el.filtroResultado.addEventListener("change", () => paginadorPartidas.ir(0));

    el.detalle.hidden = false;
    await Promise.all([cargarResumen(), cargarFiltroJuegos(), paginadorPartidas.ir(0)]);
}

iniciar();
