#!/usr/bin/env node
// Injecte les variables Supabase dans les pages HTML au moment du build.
//
// La liste des pages était tenue à la main : chaque nouvelle page publique
// était oubliée, et son client Supabase démarrait sans clé — panne visible
// seulement en production. On balaie désormais le dossier.

const fs = require('fs');
const path = require('path');

const url     = process.env.VITE_SUPABASE_URL      || process.env.SUPABASE_URL      || '';
const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

if (!url || !anonKey) {
  console.warn('[build] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY absentes — mode démo local.');
} else {
  console.log('[build] Variables Supabase injectées (' + url.substring(0, 30) + '…)');
}

// Toutes les pages du dossier, sans liste à maintenir.
const pages = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.html'))
  .sort();

let traitees = 0;
let sansMarqueur = [];

for (const name of pages) {
  const file = path.join(__dirname, name);
  let html = fs.readFileSync(file, 'utf8');

  const avait = html.includes('__CREDIGO_SUPABASE_URL__')
    || html.includes('__CREDIGO_SUPABASE_ANON_KEY__');

  if (!avait) {
    // Une page sans marqueur n'a peut-être pas besoin de Supabase — mais
    // si elle l'appelle, c'est une panne qui n'apparaîtra qu'en ligne.
    if (html.includes('supabase') || html.includes('createClient')) {
      sansMarqueur.push(name);
    }
    continue;
  }

  html = html.split('__CREDIGO_SUPABASE_URL__').join(url);
  html = html.split('__CREDIGO_SUPABASE_ANON_KEY__').join(anonKey);
  fs.writeFileSync(file, html);
  console.log('[build] ' + name + ' : variables injectées.');
  traitees += 1;
}

if (sansMarqueur.length) {
  console.warn('[build] ⚠ Ces pages utilisent Supabase sans marqueur d\'injection : '
    + sansMarqueur.join(', '));
  console.warn('[build]   Ajoutez window.CREDIGO_SUPABASE_URL = \'__CREDIGO_SUPABASE_URL__\';');
}

console.log('[build] inject-env.js terminé — ' + traitees + ' page(s) sur ' + pages.length + '.');
