import { createClient } from '@supabase/supabase-js'

const url = 'https://pspiqukuhtazmkyfleii.supabase.co'
const publishableKey = 'sb_publishable_1hwJS9G85s6GoIvF2qO7Pw_4rRG5Iag'

export const supabase = createClient(url, publishableKey)
