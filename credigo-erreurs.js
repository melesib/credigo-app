/**
 * Collecteur d'erreurs Credigo.
 *
 * À inclure sur les cinq surfaces : application entrepreneur, espace
 * financeur, back-office, portail donneur d'ordre, portail banque.
 *
 * CE QU'IL COLLECTE.
 *
 * Les erreurs JavaScript non rattrapées, les promesses rejetées, les
 * ressources qui ne se chargent pas, et les appels réseau en échec.
 *
 * CE QU'IL NE COLLECTE PAS.
 *
 * Ni le contenu des champs, ni les identifiants, ni les montants. Le
 * chemin est nettoyé de ses paramètres : /contrats?contrat=abc devient
 * /contrats. Un journal qui recopierait des données personnelles
 * créerait un risque plus grand que celui qu'il aide à réduire.
 *
 * POURQUOI IL NE DOIT JAMAIS FAIRE ÉCHOUER LA PAGE.
 *
 * Un collecteur qui plante en signalant une erreur double le problème.
 * Tout est donc enveloppé, et un échec d'envoi est silencieux.
 *
 * USAGE :
 *   <script src="/credigo-erreurs.js"></script>
 *   <script>CredigoErreurs.init({ surface: 'app_entrepreneur' });</script>
 *
 * L'adresse et la clé sont lues depuis window.CREDIGO_SUPABASE_URL et
 * window.CREDIGO_SUPABASE_ANON_KEY, remplacées au déploiement. Les
 * redonner ici créerait un risque de divergence.
 */
(function (global) {
  'use strict';

  var config = null;
  var envoyees = {};      // empreintes déjà envoyées dans cette session
  var dernierEnvoi = 0;
  var EN_ATTENTE = [];
  var MAX_PAR_MINUTE = 10;
  var compteur = 0;
  var fenetre = Date.now();

  // Le chemin sans ses paramètres : conserver l'identifiant reviendrait
  // à tracer qui consulte quoi.
  function cheminPropre() {
    try {
      var p = global.location.pathname || '';
      // Les identifiants dans le chemin deviennent un marqueur.
      return p.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
              .replace(/\/[A-Za-z0-9_-]{20,}/g, '/:token')
              .slice(0, 200);
    } catch (e) { return ''; }
  }

  function navigateur() {
    try {
      var ua = global.navigator.userAgent || '';
      // Le nom et la version suffisent : l'agent complet identifie
      // parfois une machine unique.
      var m = ua.match(/(Chrome|Safari|Firefox|Edg|OPR)\/(\d+)/);
      return m ? m[1] + ' ' + m[2] : 'inconnu';
    } catch (e) { return 'inconnu'; }
  }

  function plateforme() {
    try {
      var ua = global.navigator.userAgent || '';
      if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
      if (/Android/i.test(ua)) return 'Android';
      if (/Mac/i.test(ua)) return 'macOS';
      if (/Windows/i.test(ua)) return 'Windows';
      return 'autre';
    } catch (e) { return 'inconnu'; }
  }

  function empreinte(type, message, source, ligne) {
    return [type, String(message).slice(0, 120), source, ligne].join('|');
  }

  // Une même erreur peut se répéter des centaines de fois par seconde
  // dans une boucle : sans limite, on saturerait la base au lieu de
  // l'aider.
  function autorise() {
    var maintenant = Date.now();
    if (maintenant - fenetre > 60000) { fenetre = maintenant; compteur = 0; }
    if (compteur >= MAX_PAR_MINUTE) return false;
    compteur++;
    return true;
  }

  function envoyer(donnees) {
    if (!config || !config.url || !config.cle) return;

    var cle = empreinte(donnees.type, donnees.message, donnees.source, donnees.ligne);
    if (envoyees[cle]) return;   // déjà signalée dans cette session
    if (!autorise()) return;
    envoyees[cle] = true;

    try {
      var corps = JSON.stringify({
        p_surface: config.surface || 'inconnue',
        p_type: donnees.type,
        p_message: String(donnees.message || '').slice(0, 500),
        p_source: String(donnees.source || '').slice(0, 300),
        p_ligne: donnees.ligne || null,
        p_pile: String(donnees.pile || '').slice(0, 2000),
        p_chemin: cheminPropre(),
        p_action: donnees.action || null,
        p_navigateur: navigateur(),
        p_plateforme: plateforme(),
        p_user_id: config.userId || null
      });

      // « keepalive » permet l'envoi même si la page se ferme : sans
      // lui, les erreurs fatales — celles qui comptent le plus — se
      // perdraient.
      fetch(config.url + '/rest/v1/rpc/signaler_erreur', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': config.cle,
          'Authorization': 'Bearer ' + (config.jeton || config.cle)
        },
        body: corps,
        keepalive: true
      }).catch(function () { /* un échec d'envoi reste silencieux */ });
    } catch (e) { /* le collecteur ne doit jamais casser la page */ }
  }

  var API = {
    init: function (options) {
      if (config) return;                    // une seule initialisation
      config = options || {};

      // Les clés viennent du déploiement, pas de l'appelant.
      config.url = config.url || global.CREDIGO_SUPABASE_URL || '';
      config.cle = config.cle || global.CREDIGO_SUPABASE_ANON_KEY || '';

      // Un marqueur non remplacé signifie que le déploiement n'a pas
      // substitué les valeurs : mieux vaut ne rien envoyer que d'échouer
      // à chaque erreur.
      if (!config.url || config.url.indexOf('__CREDIGO') === 0) {
        config = null;
        return;
      }

      // ── Les erreurs JavaScript non rattrapées ──
      global.addEventListener('error', function (e) {
        try {
          // Une ressource qui ne charge pas — image, script, feuille de
          // style — arrive ici sans message : c'est un autre problème.
          if (e.target && e.target !== global && e.target.tagName) {
            envoyer({
              type: 'ressource',
              message: 'Ressource non chargée : ' + (e.target.tagName || ''),
              source: e.target.src || e.target.href || ''
            });
            return;
          }
          envoyer({
            type: 'js',
            message: e.message || 'Erreur inconnue',
            source: e.filename || '',
            ligne: e.lineno || null,
            pile: e.error && e.error.stack ? e.error.stack : ''
          });
        } catch (_) {}
      }, true);

      // ── Les promesses rejetées sans traitement ──
      global.addEventListener('unhandledrejection', function (e) {
        try {
          var r = e.reason;
          envoyer({
            type: 'js',
            message: (r && (r.message || r)) || 'Promesse rejetée',
            pile: r && r.stack ? r.stack : ''
          });
        } catch (_) {}
      });

      // ── Les appels réseau en échec ──
      // Un appel qui échoue silencieusement laisse un écran vide sans
      // que personne ne sache pourquoi.
      if (global.fetch) {
        var fetchOriginal = global.fetch;
        global.fetch = function () {
          var url = '';
          try { url = String(arguments[0] && arguments[0].url || arguments[0] || ''); }
          catch (_) {}

          return fetchOriginal.apply(this, arguments).then(function (rep) {
            try {
              // On ne signale pas nos propres envois d'erreur : cela
              // créerait une boucle.
              if (url.indexOf('signaler_erreur') >= 0) return rep;
              if (!rep.ok && rep.status >= 400) {
                envoyer({
                  type: rep.status >= 500 ? 'reseau' : 'rpc',
                  message: 'HTTP ' + rep.status + ' sur ' + nettoyerUrl(url),
                  source: nettoyerUrl(url)
                });
              }
            } catch (_) {}
            return rep;
          }).catch(function (err) {
            try {
              if (url.indexOf('signaler_erreur') < 0) {
                envoyer({
                  type: 'reseau',
                  message: 'Appel échoué : ' + (err && err.message || 'réseau'),
                  source: nettoyerUrl(url)
                });
              }
            } catch (_) {}
            throw err;
          });
        };
      }
    },

    // Signalement manuel, pour les erreurs qu'on rattrape soi-même.
    signaler: function (message, action) {
      envoyer({ type: 'js', message: message, action: action });
    },

    // Rattacher les erreurs suivantes à un utilisateur connecté.
    identifier: function (userId, jeton) {
      if (!config) return;
      config.userId = userId || null;
      if (jeton) config.jeton = jeton;
    }
  };

  // L'adresse sans ses paramètres ni sa clé : une URL d'API contient
  // souvent un jeton.
  function nettoyerUrl(u) {
    try {
      return String(u).split('?')[0]
        .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
        .slice(0, 200);
    } catch (e) { return ''; }
  }

  global.CredigoErreurs = API;
})(typeof window !== 'undefined' ? window : this);
