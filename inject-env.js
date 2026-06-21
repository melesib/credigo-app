#!/usr/bin/env node
// Remplace les placeholders __CREDIGO_SUPABASE_URL__ et
// __CREDIGO_SUPABASE_ANON_KEY__ dans index.html par les vraies valeurs
// définies en variables d'environnement Netlify (Site settings →
// Environment variables → VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).
//
// Si les variables sont absentes (ex : déploiement de preview sans
// config), le placeholder reste tel quel et l'app continue de
// fonctionner en mode démo local grâce au repli prévu dans
// credigo-supabase.js.

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'index.html');
let html = fs.readFileSync(file, 'utf8');

const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

if (!url || !anonKey) {
  console.warn(
    '[build] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY non définies — ' +
    'l\'app sera déployée en mode démo (localStorage uniquement).'
  );
} else {
  console.log('[build] Variables Supabase injectées avec succès.');
}

html = html.replace('__CREDIGO_SUPABASE_URL__', url);
html = html.replace('__CREDIGO_SUPABASE_ANON_KEY__', anonKey);

fs.writeFileSync(file, html);
