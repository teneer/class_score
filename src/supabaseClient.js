// src/supabaseClient.js
import { createClient } from '@supabase/supabase-js'

// 1) .env에 넣어 둔 값을 읽어옵니다.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// 2) 클라이언트 생성
export const supabase = createClient(supabaseUrl, supabaseAnonKey)
