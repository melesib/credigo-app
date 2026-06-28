#!/usr/bin/env node
// Injecte les variables Supabase dans index.html au moment du build Netlify.
// Utilise replaceAll() pour remplacer TOUTES les occurrences des placeholders.

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'index.html');
let html = fs.readFileSync(file, 'utf8');

const url     = process.env.VITE_SUPABASE_URL     || process.env.SUPABASE_URL     || '';
const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

if (!url || !anonKey) {
  console.warn('[build] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY absentes — mode démo local.');
} else {
  console.log('[build] Variables Supabase injectées (' + url.substring(0, 30) + '...)');
}

// replaceAll remplace TOUTES les occurrences, pas seulement la première
html = html.split('__CREDIGO_SUPABASE_URL__').join(url);
html = html.split('__CREDIGO_SUPABASE_ANON_KEY__').join(anonKey);

fs.writeFileSync(file, html);
console.log('[build] inject-env.js terminé.');
