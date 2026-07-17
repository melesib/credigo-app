#!/usr/bin/env node
// Injecte les variables Supabase dans les pages HTML au moment du build Netlify.
// Deux pages sont concernées : l'app (index.html) et la page publique de
// confirmation du donneur d'ordre (confirmation.html).
// Utilise replaceAll() pour remplacer TOUTES les occurrences des placeholders.

const fs = require('fs');
const path = require('path');

const files = ['index.html', 'confirmation.html'];

const url     = process.env.VITE_SUPABASE_URL     || process.env.SUPABASE_URL     || '';
const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

if (!url || !anonKey) {
  console.warn('[build] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY absentes — mode démo local.');
} else {
  console.log('[build] Variables Supabase injectées (' + url.substring(0, 30) + '...)');
}

for (const name of files) {
  const file = path.join(__dirname, name);
  if (!fs.existsSync(file)) { console.warn('[build] ' + name + ' introuvable, ignoré.'); continue; }
  let html = fs.readFileSync(file, 'utf8');
  // split/join remplace TOUTES les occurrences, pas seulement la première
  html = html.split('__CREDIGO_SUPABASE_URL__').join(url);
  html = html.split('__CREDIGO_SUPABASE_ANON_KEY__').join(anonKey);
  fs.writeFileSync(file, html);
  console.log('[build] ' + name + ' : variables injectées.');
}
console.log('[build] inject-env.js terminé.');
