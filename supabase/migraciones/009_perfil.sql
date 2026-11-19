-- =====================================================================
-- 009_perfil.sql
-- Permite que el jugador edite SOLO su nombre y su username.
--
-- Por qué una función y no un UPDATE directo desde el navegador:
--   * La tabla "usuario" no tiene política de UPDATE, así que con RLS un
--     update directo no cambia ninguna fila. Eso es lo que queremos: si
--     existiera una política de UPDATE, el usuario podría mandar también
--     { tokens: 999999 } desde la consola, porque RLS decide QUÉ FILAS se
--     pueden tocar, no QUÉ COLUMNAS.
--   * Esta función es SECURITY DEFINER (corre con permisos del dueño y
--     salta RLS), pero su UPDATE está escrito a mano y solo menciona
--     nombre y username, y solo para la fila de auth.uid().
--     Tokens, correo y fecha_registro no se pueden tocar por aquí.
--
-- Errores (el frontend los traduce al español):
--   NO_AUTENTICADO, NOMBRE_INVALIDO, USERNAME_INVALIDO, USERNAME_OCUPADO,
--   PERFIL_NO_ENCONTRADO
-- =====================================================================

begin;

create or replace function public.actualizar_perfil(p_nombre text, p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid    uuid := auth.uid();
    v_perfil public.usuario%rowtype;
begin
    if v_uid is null then
        raise exception 'NO_AUTENTICADO';
    end if;

    -- Nombre: 1 a 60 caracteres, sin espacios (ni tabs/saltos) al inicio o al final.
    if p_nombre is null
       or char_length(p_nombre) not between 1 and 60
       or p_nombre ~ '^\s' or p_nombre ~ '\s$' then
        raise exception 'NOMBRE_INVALIDO';
    end if;

    -- Username: 3 a 20 caracteres, solo letras sin acento, números y guion bajo.
    if p_username is null or p_username !~ '^[A-Za-z0-9_]{3,20}$' then
        raise exception 'USERNAME_INVALIDO';
    end if;

    -- ¿Lo usa otro jugador? (misma regla que la restricción UNIQUE: distingue mayúsculas)
    if exists (select 1 from public.usuario
               where username = p_username and id_usuario <> v_uid) then
        raise exception 'USERNAME_OCUPADO';
    end if;

    -- El único UPDATE: solo nombre y username de la fila propia.
    begin
        update public.usuario
           set nombre = p_nombre,
               username = p_username
         where id_usuario = v_uid
        returning * into v_perfil;
    exception
        -- Dos personas pidieron el mismo username al mismo tiempo: la
        -- comprobación de arriba pasó para ambas, pero UNIQUE frena a la segunda.
        when unique_violation then
            raise exception 'USERNAME_OCUPADO';
    end;

    -- Si no había fila para este usuario, el RETURNING deja v_perfil vacío.
    if v_perfil.id_usuario is null then
        raise exception 'PERFIL_NO_ENCONTRADO';
    end if;

    return jsonb_build_object(
        'nombre',         v_perfil.nombre,
        'username',       v_perfil.username,
        'correo',         v_perfil.correo,
        'tokens',         v_perfil.tokens,
        'fecha_registro', v_perfil.fecha_registro
    );
end;
$$;

revoke execute on function public.actualizar_perfil(text, text) from public, anon;
grant  execute on function public.actualizar_perfil(text, text) to authenticated;

commit;
