
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://cshhjrqblwndbmchghdi.supabase.co";
const SUPABASE_KEY = "sb_publishable_NWhO_ANcIjmMWdqq-xissw_HrfpEuA8";

export const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_KEY
);
