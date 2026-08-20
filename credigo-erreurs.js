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

      // ── Les appels par XMLHttpRequest ──
      // Certaines bibliothèques l'emploient encore : sans cela, leurs
      // échecs seraient totalement invisibles.
      if (global.XMLHttpRequest) {
        var ouvrirXhr = global.XMLHttpRequest.prototype.open;
        global.XMLHttpRequest.prototype.open = function (methode, adresse) {
          this.__url = adresse;
          return ouvrirXhr.apply(this, arguments);
        };
        var envoyerXhr = global.XMLHttpRequest.prototype.send;
        global.XMLHttpRequest.prototype.send = function () {
          var xhr = this;
          xhr.addEventListener('error', function () {
            try {
              envoyer({ type: 'reseau',
                message: 'Requête échouée (XHR)',
                source: nettoyerUrl(xhr.__url || '') });
            } catch (_) {}
          });
          xhr.addEventListener('timeout', function () {
            try {
              envoyer({ type: 'lenteur',
                message: 'Requête expirée (XHR)',
                source: nettoyerUrl(xhr.__url || '') });
            } catch (_) {}
          });
          xhr.addEventListener('load', function () {
            try {
              if (xhr.status >= 400 && !attendu(xhr.__url, xhr.status)) {
                envoyer({ type: xhr.status >= 500 ? 'reseau' : 'rpc',
                  message: natureHttp(xhr.status) + ' (' + xhr.status + ')',
                  source: nettoyerUrl(xhr.__url || '') });
              }
            } catch (_) {}
          });
          return envoyerXhr.apply(this, arguments);
        };
      }

      // ── Les appels réseau en échec ──
      // Un appel qui échoue silencieusement laisse un écran vide sans
      // que personne ne sache pourquoi.
      if (global.fetch) {
        var fetchOriginal = global.fetch;
        global.fetch = function () {
          var url = '';
          try { url = String(arguments[0] && arguments[0].url || arguments[0] || ''); }
          catch (_) {}

          // Un appel qui n'aboutit pas au bout de trente secondes est
          // perdu pour l'utilisateur, qu'il finisse ou non : il a déjà
          // rechargé ou quitté.
          var depart = Date.now();
          var minuteur = setTimeout(function () {
            try {
              if (url.indexOf('signaler_erreur') < 0 && !global.document.hidden) {
                envoyer({
                  type: 'lenteur',
                  message: 'Appel sans réponse après 30 s',
                  source: nettoyerUrl(url)
                });
              }
            } catch (_) {}
          }, 30000);

          return fetchOriginal.apply(this, arguments).then(function (rep) {
            clearTimeout(minuteur);
            try {
              // On ne signale pas nos propres envois d'erreur : cela
              // créerait une boucle.
              if (url.indexOf('signaler_erreur') >= 0) return rep;
              if (!rep.ok && rep.status >= 400 && !attendu(url, rep.status)) {
                envoyer({
                  type: rep.status >= 500 ? 'reseau' : 'rpc',
                  message: natureHttp(rep.status) + ' (' + rep.status + ') sur '
                    + nettoyerUrl(url),
                  source: nettoyerUrl(url)
                });
              }
            } catch (_) {}
            return rep;
          }).catch(function (err) {
            clearTimeout(minuteur);
            try {
              if (url.indexOf('signaler_erreur') < 0 && !interrompu(err)) {
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

  // Certains appels échouent normalement et se rattrapent seuls : les
  // compter ferait du bruit sans rien apprendre.
  //
  //   /auth/v1/token   — rafraîchissement de session, Supabase réessaie
  //   /auth/v1/logout  — déconnexion, échoue si la session a déjà expiré
  //   /auth/v1/user    — vérification de session au démarrage
  //
  // Une vraie panne d'authentification se voit autrement : l'utilisateur
  // se retrouve sur l'écran de connexion.
  function attendu(url, code) {
    var u = String(url || '');
    if (u.indexOf('/auth/v1/token') >= 0) return true;
    if (u.indexOf('/auth/v1/logout') >= 0) return true;
    if (u.indexOf('/auth/v1/user') >= 0 && code === 401) return true;
    // Un 401 sur une lecture signifie souvent que la session vient
    // d'expirer : le rafraîchissement suit immédiatement.
    if (code === 401 && u.indexOf('/rest/v1/') >= 0) return true;
    // Une ressource absente n'est pas une panne applicative.
    if (code === 404 && u.indexOf('/storage/') >= 0) return true;
    return false;
  }

  // Un code HTTP seul ne dit rien à qui lit le journal : le traduire
  // oriente vers la bonne cause.
  function natureHttp(code) {
    if (code === 401 || code === 403) return 'Session expirée ou accès refusé';
    if (code === 404) return 'Ressource introuvable';
    if (code === 409) return 'Conflit de données';
    if (code === 413) return 'Fichier trop volumineux';
    if (code === 429) return 'Trop de requêtes — limite atteinte';
    if (code === 502 || code === 503 || code === 504) return 'Serveur indisponible';
    if (code >= 500) return 'Erreur serveur';
    return 'Requête refusée';
  }

  // Quitter une page annule ses appels en cours : le navigateur les
  // rapporte comme des échecs, alors que rien n'est cassé. Les compter
  // masquerait les vraies pannes sous le bruit.
  function interrompu(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    var m = String(err.message || '').toLowerCase();
    // La page se ferme ou change : l'appel n'avait plus de destinataire.
    if (global.document && global.document.hidden) return true;
    return m.indexOf('aborted') >= 0
      || m.indexOf('cancelled') >= 0
      || m.indexOf('canceled') >= 0
      || m.indexOf('network request failed') >= 0 && global.__quitte === true;
  }

  // On note le départ pour distinguer un appel interrompu d'une vraie
  // coupure réseau.
  if (typeof global.addEventListener === 'function') {
    global.addEventListener('pagehide', function () { global.__quitte = true; });
    global.addEventListener('beforeunload', function () { global.__quitte = true; });
  }

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
