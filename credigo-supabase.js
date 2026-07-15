/* ════════════════════════════════════════════════════════════════
   CREDIGO — Intégration Supabase
   ════════════════════════════════════════════════════════════════
   Ce module se charge AVANT le reste du script applicatif et
   surcharge les fonctions auth / KYC pour qu'elles persistent dans
   Supabase au lieu de (ou en plus de) localStorage.

   Principe : si Supabase n'est pas configuré (clés absentes), l'app
   continue de fonctionner exactement comme avant (mode démo
   localStorage). Aucune régression possible en cas de mauvaise config.
   ════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Configuration ────────────────────────────────────────────
  // Ces deux valeurs sont injectées au build (voir scripts/inject-env.js)
  // ou peuvent être codées en dur ici si vous ne passez pas par un build.
  var SUPABASE_URL = window.CREDIGO_SUPABASE_URL || '';
  var SUPABASE_ANON_KEY = window.CREDIGO_SUPABASE_ANON_KEY || '';

  var supabaseReady = !!(SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase);
  var sb = supabaseReady ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

  if (!supabaseReady) {
    console.warn(
      '[Credigo] Supabase non configuré — l\'app fonctionne en mode démo local (localStorage). ' +
      'Voir SUPABASE_SETUP.md pour activer la persistance réelle.'
    );
  }

  // Expose pour usage/debug
  window.CredigoDB = { sb: sb, ready: supabaseReady };

  // Fonction de refresh standalone - utilisable même sans session locale
  window.credigoForceRefreshStatus = async function(email, portal) {
    if (!supabaseReady || !sb) return null;
    try {
      if (email) {
        var q = sb.from('app_users')
          .select('id, kyc_status, profile_complete, kyc_required_docs, kyc_resubmit_allowed, kyc_resubmit_note')
          .eq('email', email)
          .is('deleted_at', null);
        if (portal) q = q.eq('portal', portal === 'e' ? 'entrepreneur' : 'financeur');
        var r = await q.limit(1).maybeSingle();
        if (r.error || !r.data) return null;
        var data = r.data;
        data.kyc_required_docs = data.kyc_required_docs || null;
        data.kyc_resubmit_allowed = data.kyc_resubmit_allowed || false;
        data.kyc_resubmit_note = data.kyc_resubmit_note || null;
        data.kyc_rejected_docs = {};
        if (data.kyc_status === 'rejected') {
          // Motif de rejet global
          var sub = await sb.from('kyc_submissions')
            .select('decision_notes')
            .eq('app_user_id', data.id)
            .eq('status', 'rejected')
            .order('reviewed_at', { ascending: false })
            .limit(1).maybeSingle();
          data.rejection_reason = (sub && sub.data && sub.data.decision_notes) || null;
          // Motifs de rejet par document
          var rejDocs = await sb.from('kyc_documents')
            .select('doc_type, rejection_reason')
            .eq('app_user_id', data.id)
            .eq('status', 'rejected');
          if (!rejDocs.error && rejDocs.data) {
            rejDocs.data.forEach(function(d) {
              if (d.rejection_reason) data.kyc_rejected_docs[d.doc_type] = d.rejection_reason;
              // Si un doc est rejeté, l'ajouter aux reqDocs si pas déjà présent
              if (!data.kyc_required_docs) data.kyc_required_docs = [];
              if (!data.kyc_required_docs.includes(d.doc_type)) {
                data.kyc_required_docs.push(d.doc_type);
                data.kyc_resubmit_allowed = true;
              }
            });
          }
        }
        return data;
      }
      return null;
    } catch(e) { console.error('[refresh]', e); return null; }
  };

  // ── Helpers ──────────────────────────────────────────────────
  function currentAppUserId() {
    try {
      var s = JSON.parse(localStorage.getItem('credigo_session') || 'null');
      return s ? s.dbUserId : null;
    } catch (e) { return null; }
  }

  function nowIso() { return new Date().toISOString(); }

  // ════════════════════════════════════════════════════════════
  // AUTH — surcharge des fonctions définies plus loin dans le script
  // principal. On les redéfinit ICI ; comme ce fichier est chargé
  // AVANT, le script principal qui réécrit `function authGoogleLogin`
  // etc. à la racine écrasera ces versions — donc au lieu de redéfinir
  // les noms, on s'attache via un hook posé sur authSaveSession.
  // ════════════════════════════════════════════════════════════

  /**
   * Appelé juste après que l'app ait construit l'objet `user` local
   * (voir patch dans authSaveSession côté app-source). Crée ou met à
   * jour la ligne app_users correspondante dans Supabase, puis stocke
   * son id pour les opérations suivantes (upload doc, submit KYC...).
   */
  window.credigoSyncUserToSupabase = async function (user) {
    if (!supabaseReady) return user;

    try {
      var portal = user.role === 'e' ? 'entrepreneur' : 'financeur';
      var nameParts = (user.name || '').split(' ');

      // Upsert sur (email, portal) — un même email peut avoir un compte
      // entrepreneur ET un compte financeur séparés.
      // Chercher le compte existant (inclut les supprimés pour détecter les tentatives)
      var existing = await sb
        .from('app_users')
        .select('id, kyc_status, profile_complete, is_active, blocked_reason, deleted_at, rccm_number, company_name, first_name, last_name')
        .eq('email', user.email)
        .eq('portal', portal)
        .maybeSingle();

      var dbUser;
      if (existing.data) {
        dbUser = existing.data;
        // Compte supprimé définitivement - bloquer la connexion
        if (dbUser.deleted_at) {
          return { error: 'ACCOUNT_DELETED', message: 'Ce compte a \u00e9t\u00e9 supprim\u00e9 d\u00e9finitivement. Contactez support@credigo.ci.' };
        }
        // Compte bloqué
        if (dbUser.is_active === false) {
          var reason = dbUser.blocked_reason || 'Votre compte a été suspendu. Contactez support@credigo.ci.';
          return { error: 'ACCOUNT_BLOCKED', message: reason };
        }
      } else {
        // Vérifier que cet email n'est pas un email staff back-office
        var staffCheck = await sb
          .from('staff_members')
          .select('id, is_active')
          .eq('email', user.email)
          .eq('is_active', true)
          .limit(1)
          .maybeSingle();

        if (staffCheck.data) {
          return { error: 'STAFF_EMAIL_BLOCKED', message: 'Cet email est r\u00e9serv\u00e9 au personnel Credigo. Utilisez un autre email pour cr\u00e9er un compte client.' };
        }

        // Nouveau compte - créer normalement
        var inserted = await sb
          .from('app_users')
          .insert({
            email: user.email,
            portal: portal,
            first_name: nameParts[0] || '',
            last_name: nameParts.slice(1).join(' ') || '',
            kyc_status: 'not_started',
            profile_complete: false,
          })
          .select('id, kyc_status, profile_complete')
          .single();
        if (inserted.error) {
          // Refus du verrou en base : la fonctionnalité financeur est coupée.
          // Couvre la création ET la connexion (le RLS masque le profil, donc
          // l'app tente un insert, que le trigger refuse).
          if ((inserted.error.message || '').indexOf('FINANCEUR_DISABLED') > -1) {
            return {
              error: 'FINANCEUR_DISABLED',
              message: 'L\'espace financeur n\'est pas disponible pour le moment. Contactez support@credigo.ci pour en savoir plus.'
            };
          }
          throw inserted.error;
        }
        dbUser = inserted.data;
      }

      user.dbUserId = dbUser.id;
      user.kycStatus = dbUser.kyc_status;
      user.profileComplete = dbUser.profile_complete;
      user.isActive = dbUser.is_active !== false;
      user.rccm_number = dbUser.rccm_number || null;
      user.company_name = dbUser.company_name || null;
      user.first_name = dbUser.first_name || null;
      user.last_name = dbUser.last_name || null;
      return user;
    } catch (err) {
      console.error('[Credigo] Échec sync utilisateur Supabase :', err.message);
      return user;
    }
  };

  /**
   * Authentifie réellement via Supabase Auth (email/mot de passe).
   * Retourne { user, error }.
   */
  window.credigoSupabaseSignIn = async function (email, password) {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var res = await sb.auth.signInWithPassword({ email: email, password: password });
    if (res.error) return { error: res.error.message };
    return { authUser: res.data.user };
  };

  window.credigoSupabaseSignUp = async function (email, password) {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var res = await sb.auth.signUp({ email: email, password: password });
    if (res.error) return { error: res.error.message };
    return { authUser: res.data.user, needsEmailConfirmation: !res.data.session };
  };

  window.credigoSupabaseGoogleAuth = async function () {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var res = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (res.error) return { error: res.error.message };
    return { redirecting: true };
  };

  window.credigoSupabaseSignOut = async function () {
    if (!supabaseReady) return;
    await sb.auth.signOut();
  };

  // Au chargement, si on revient d'une redirection OAuth Google,
  // récupérer la session et synchroniser.
  if (supabaseReady) {
    sb.auth.getSession().then(function (res) {
      var session = res.data && res.data.session;
      if (session && session.user && typeof window.authHandleSupabaseSession === 'function') {
        window.authHandleSupabaseSession(session.user);
      }
    });
  }

  // ════════════════════════════════════════════════════════════
  // PROFIL — sauvegarde des champs du formulaire profil utilisateur
  // ════════════════════════════════════════════════════════════

  window.credigoSaveProfile = async function (fields) {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };

    var payload = Object.assign({}, fields, { updated_at: nowIso() });
    // Calcule si le profil est "complet" : tous les champs obligatoires
    // minimaux sont renseignés. Le détail exact des champs requis dépend
    // du portail ; ici un set raisonnable, ajustable.
    var requiredCommon = ['first_name', 'last_name', 'phone', 'address', 'date_of_birth'];
    var requiredEntrepreneur = ['company_name', 'rccm_number', 'sector'];
    var isComplete = requiredCommon.every(function (k) { return !!payload[k]; });
    if (payload.portal === 'entrepreneur') {
      isComplete = isComplete && requiredEntrepreneur.every(function (k) { return !!payload[k]; });
    }
    payload.profile_complete = isComplete;

    var res = await sb.from('app_users').update(payload).eq('id', userId).select().single();
    if (res.error) return { error: res.error.message };
    return { user: res.data };
  };

  // Relit le profil complet de l'utilisateur depuis Supabase
  window.credigoGetProfile = async function () {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };
    // select('*') : on prend toutes les colonnes existantes, sans risque de demander une colonne absente
    var res = await sb.from('app_users').select('*').eq('id', userId).single();
    if (res.error) return { error: res.error.message };
    return { profile: res.data };
  };

  // ════════════════════════════════════════════════════════════
  // SCORE DE FIABILITÉ
  // ════════════════════════════════════════════════════════════

  // Lit le score et son détail depuis Supabase
  window.credigoGetScore = async function () {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };
    var res = await sb.from('app_users')
      .select('reliability_score, score_breakdown, kyc_status, profile_complete')
      .eq('id', userId).single();
    if (res.error) return { error: res.error.message };
    return { score: res.data };
  };

  // Lit les références de l'entrepreneur
  window.credigoGetReferences = async function () {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };
    var res = await sb.from('entrepreneur_references')
      .select('*').eq('app_user_id', userId).order('created_at', { ascending: false });
    if (res.error) return { error: res.error.message };
    return { references: res.data || [] };
  };

  // Ajoute une référence (statut pending, à vérifier par le BO)
  window.credigoAddReference = async function (ref) {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };
    var payload = {
      app_user_id: userId,
      contact_name: ref.contact_name || '',
      organization: ref.organization || null,
      contact_phone: ref.contact_phone || null,
      contact_email: ref.contact_email || null,
      market_object: ref.market_object || null,
      market_amount: ref.market_amount || null,
      status: 'pending'
    };
    var res = await sb.from('entrepreneur_references').insert(payload).select().single();
    if (res.error) return { error: res.error.message };
    return { reference: res.data };
  };

  // Lit les attestations de l'entrepreneur
  window.credigoGetAttestations = async function () {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };
    var res = await sb.from('execution_attestations')
      .select('*').eq('app_user_id', userId).order('created_at', { ascending: false });
    if (res.error) return { error: res.error.message };
    return { attestations: res.data || [] };
  };

  // Ajoute une attestation (statut pending, à vérifier par le BO)
  window.credigoAddAttestation = async function (att) {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };
    var payload = {
      app_user_id: userId,
      market_object: att.market_object || '',
      market_amount: att.market_amount || null,
      issuing_authority: att.issuing_authority || null,
      issue_date: att.issue_date || null,
      document_path: att.document_path || null,
      document_name: att.document_name || null,
      status: 'pending'
    };
    var res = await sb.from('execution_attestations').insert(payload).select().single();
    if (res.error) return { error: res.error.message };
    return { attestation: res.data };
  };

  // Upload d'un fichier attestation vers le bucket "attestations"
  // Accepte PDF, Word, Excel, images, etc. Chemin préfixé par app_user_id.
  window.credigoUploadAttestationFile = async function (file) {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };
    // Limite de taille : 10 Mo
    if (file.size > 10 * 1024 * 1024) {
      return { error: 'Le fichier dépasse 10 Mo. Choisissez un fichier plus léger.' };
    }
    try {
      var parts = (file.name || 'document').split('.');
      var ext = parts.length > 1 ? parts.pop().toLowerCase() : 'bin';
      var safeName = 'attestation_' + Date.now() + '.' + ext;
      var path = userId + '/' + safeName;
      var up = await sb.storage.from('attestations').upload(path, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || 'application/octet-stream'
      });
      if (up.error) return { error: up.error.message };
      return { path: path, name: file.name };
    } catch (e) {
      return { error: e.message || 'Échec de l\'envoi du fichier.' };
    }
  };

  // ════════════════════════════════════════════════════════════
  // NOTIFICATIONS
  // ════════════════════════════════════════════════════════════

  // Lit les notifications de l'utilisateur (les plus récentes d'abord)
  window.credigoGetNotifications = async function () {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };
    var res = await sb.from('notifications')
      .select('*').eq('app_user_id', userId)
      .order('created_at', { ascending: false }).limit(50);
    if (res.error) return { error: res.error.message };
    return { notifications: res.data || [] };
  };

  // Compte les notifications non lues
  window.credigoCountUnread = async function () {
    if (!supabaseReady) return { count: 0 };
    var userId = currentAppUserId();
    if (!userId) return { count: 0 };
    var res = await sb.from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('app_user_id', userId).eq('is_read', false);
    if (res.error) return { count: 0 };
    return { count: res.count || 0 };
  };

  // Marque une notification comme lue
  window.credigoMarkNotifRead = async function (notifId) {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var res = await sb.from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', notifId);
    if (res.error) return { error: res.error.message };
    return { success: true };
  };

  // Marque toutes les notifications comme lues
  window.credigoMarkAllNotifsRead = async function () {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };
    var res = await sb.from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('app_user_id', userId).eq('is_read', false);
    if (res.error) return { error: res.error.message };
    return { success: true };
  };

  // ════════════════════════════════════════════════════════════
  // CONTRATS / DEMANDES DE FINANCEMENT
  // ════════════════════════════════════════════════════════════

  // Crée une demande de financement
  window.credigoCreateRequest = async function (req) {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };
    var payload = {
      app_user_id: userId,
      type: req.type || 'commande',
      market_object: req.market_object || '',
      market_amount: req.market_amount || 0,
      reference: req.reference || null,
      date_start: req.date_start || null,
      date_end: req.date_end || null,
      date_payment: req.date_payment || null,
      donneur_ordre_name: req.donneur_ordre_name || null,
      bank_partner: req.bank_partner || null,
      bank_account_number: req.bank_account_number || null,
      needs_account_opening: req.needs_account_opening ? true : false,
      estimated_fees: req.estimated_fees || null,
      estimated_payout: req.estimated_payout || null,
      domiciliation_consent: req.domiciliation_consent ? true : false,
      domiciliation_consent_at: req.domiciliation_consent ? new Date().toISOString() : null,
      status: 'submitted'
    };
    var res = await sb.from('financing_requests').insert(payload).select().single();
    if (res.error) return { error: res.error.message };
    // Journaliser l'événement de soumission (best-effort, non bloquant)
    try {
      await sb.from('request_events').insert({
        request_id: res.data.id, event_type: 'submitted',
        to_status: 'submitted', actor_type: 'entrepreneur', actor_id: userId
      });
    } catch (e) { /* non bloquant */ }
    return { request: res.data };
  };

  // Lit les demandes de l'utilisateur (les plus récentes d'abord)
  window.credigoGetRequests = async function () {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };
    var res = await sb.from('financing_requests')
      .select('*').eq('app_user_id', userId)
      .order('created_at', { ascending: false });
    if (res.error) return { error: res.error.message };
    return { requests: res.data || [] };
  };

  // Lit la liste des banques partenaires actives (pour le wizard)
  // Lit les paramètres de tarification et calcule le taux selon le score du client
  // Crée une notification "profil complété" une seule fois (anti-doublon)
  window.credigoNotifyProfileComplete = async function () {
    if (!supabaseReady) return;
    var userId = currentAppUserId();
    if (!userId) return;
    try {
      // Vérifier qu'on n'a pas déjà notifié
      var existing = await sb.from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('app_user_id', userId)
        .eq('related_type', 'profile_complete');
      if (existing.count && existing.count > 0) return;
      await sb.from('notifications').insert({
        app_user_id: userId,
        title: 'Profil complété ✓',
        body: 'Votre profil est complet. Prochaine étape : la vérification de votre identité (KYC).',
        category: 'success',
        target_screen: 'e-profile',
        related_type: 'profile_complete'
      });
    } catch (e) { /* non bloquant */ }
  };

  // ════════════════════════════════════════════════════════════
  // RÉGLAGES DE FONCTIONNALITÉS (interrupteurs)
  // ════════════════════════════════════════════════════════════
  // Sécurité : en cas de doute (pas de connexion, erreur de lecture), la
  // fonctionnalité est considérée FERMÉE. Mieux vaut refuser à tort que
  // d'ouvrir une fonctionnalité sous réserve juridique.
  // Note : ce masquage sert le confort de l'utilisateur. La vraie protection
  // est en base (trigger + RLS) et ne dépend pas de l'app.
  var _flagCache = {};
  window.credigoIsFeatureEnabled = async function (key) {
    if (!supabaseReady) return false;
    if (_flagCache[key] !== undefined) return _flagCache[key];
    try {
      var res = await sb.from('feature_flags').select('enabled').eq('key', key).maybeSingle();
      if (res.error) return false;
      var val = !!(res.data && res.data.enabled);
      _flagCache[key] = val;
      return val;
    } catch (e) {
      return false;
    }
  };

  window.credigoGetRate = async function () {
    if (!supabaseReady) return { rate: 3.0 };
    var userId = currentAppUserId();
    var ps = await sb.from('pricing_settings').select('*').eq('id', 1).single();
    if (ps.error || !ps.data) return { rate: 3.0 };
    var s = ps.data;
    var score = 55;
    if (userId) {
      var us = await sb.from('app_users').select('reliability_score').eq('id', userId).single();
      if (!us.error && us.data && typeof us.data.reliability_score === 'number') score = us.data.reliability_score;
    }
    var rate;
    if (score >= s.pivot_score) {
      rate = (100 - s.pivot_score) === 0 ? s.base_rate
        : s.base_rate - s.score_discount * (score - s.pivot_score) / (100 - s.pivot_score);
    } else {
      rate = s.pivot_score === 0 ? s.base_rate
        : s.base_rate + s.score_penalty * (s.pivot_score - score) / s.pivot_score;
    }
    rate = Math.max(s.min_rate, Math.min(s.max_rate, rate));
    return { rate: Math.round(rate * 100) / 100, score: score };
  };

  window.credigoGetBanques = async function () {
    if (!supabaseReady) return { banques: [] };
    var res = await sb.from('banques_partenaires')
      .select('id, name, short_name, logo_url, logo_fit')
      .eq('is_active', true)
      .order('ordre', { ascending: true });
    if (res.error) return { banques: [] };
    return { banques: res.data || [] };
  };

  // Lit la liste des donneurs d'ordre partenaires (pour le wizard)
  window.credigoGetPartnerDonneurs = async function () {
    if (!supabaseReady) return { donneurs: [] };
    var res = await sb.from('donneurs_ordre')
      .select('id, name, is_partner, is_public')
      .eq('is_partner', true)
      .order('name', { ascending: true });
    if (res.error) return { donneurs: [] };
    return { donneurs: res.data || [] };
  };

  // Lit une demande précise avec son journal d'événements
  window.credigoGetRequestDetail = async function (requestId) {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var res = await sb.from('financing_requests').select('*').eq('id', requestId).single();
    if (res.error) return { error: res.error.message };
    var ev = await sb.from('request_events').select('*').eq('request_id', requestId).order('created_at', { ascending: true });
    return { request: res.data, events: (ev.data || []) };
  };

  // Upload d'un document de demande vers le bucket "attestations" (réutilisé)
  // puis enregistrement dans request_documents.
  window.credigoUploadRequestDoc = async function (requestId, file, docType) {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };
    if (file.size > 10 * 1024 * 1024) return { error: 'Le fichier dépasse 10 Mo.' };
    try {
      var parts = (file.name || 'document').split('.');
      var ext = parts.length > 1 ? parts.pop().toLowerCase() : 'bin';
      var path = userId + '/requests/' + requestId + '_' + Date.now() + '.' + ext;
      var up = await sb.storage.from('attestations').upload(path, file, {
        cacheControl: '3600', upsert: false,
        contentType: file.type || 'application/octet-stream'
      });
      if (up.error) return { error: up.error.message };
      var ins = await sb.from('request_documents').insert({
        request_id: requestId,
        document_path: path,
        document_name: file.name,
        doc_type: docType || 'autre'
      }).select().single();
      if (ins.error) return { error: ins.error.message };
      return { document: ins.data };
    } catch (e) {
      return { error: e.message || 'Échec de l\'envoi du fichier.' };
    }
  };

  /**
   * Upload un fichier KYC. `file` est un objet File (input type=file).
   * Retourne { error } ou { document }.
   */
  window.credigoUploadKycDocument = async function (docType, docLabel, stepNumber, file) {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };
    if (!file) return { error: 'Aucun fichier fourni.' };

    try {
      var path = userId + '/' + docType + '_' + Date.now() + '_' + file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
      var upload = await sb.storage.from('kyc-documents').upload(path, file, { upsert: true });
      if (upload.error) throw upload.error;

      var res = await sb
        .from('kyc_documents')
        .upsert({
          app_user_id: userId,
          doc_type: docType,
          doc_label: docLabel,
          step_number: stepNumber,
          file_url: path,
          file_name: file.name,
          file_size_bytes: file.size,
          status: 'uploaded',
          uploaded_at: nowIso(),
        }, { onConflict: 'app_user_id,doc_type' })
        .select()
        .single();

      if (res.error) throw res.error;
      return { document: res.data };
    } catch (err) {
      return { error: err.message };
    }
  };

  /**
   * Enregistre un document "signé en ligne" (PDF généré côté client,
   * pas un upload de fichier scanné) — même logique mais avec un Blob
   * généré par jsPDF au lieu d'un File utilisateur.
   */
  window.credigoSaveGeneratedPdf = async function (docType, docLabel, stepNumber, pdfBlob, filename) {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var file = new File([pdfBlob], filename, { type: 'application/pdf' });
    return window.credigoUploadKycDocument(docType, docLabel, stepNumber, file);
  };

  /**
   * Soumet le dossier KYC complet : crée une ligne kyc_submissions et
   * passe app_users.kyc_status à 'pending_review'. C'est cette action
   * qui fait apparaître le dossier dans la file d'attente du back-office.
   */
  window.credigoSubmitKycDossier = async function (fingerprint) {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };

    try {
      var countRes = await sb
        .from('kyc_submissions')
        .select('id', { count: 'exact', head: true })
        .eq('app_user_id', userId);
      var submissionNumber = (countRes.count || 0) + 1;

      var sub = await sb
        .from('kyc_submissions')
        .insert({
          app_user_id: userId,
          submission_number: submissionNumber,
          status: 'pending_review',
          submitted_at: nowIso(),
          ip_address: (fingerprint && fingerprint.ip) || null,
          user_agent: navigator.userAgent,
          device_fingerprint: (fingerprint && fingerprint.canvasFp) || null,
        })
        .select()
        .single();
      if (sub.error) throw sub.error;

      var upd = await sb.from('app_users').update({ kyc_status: 'pending_review' }).eq('id', userId);
      if (upd.error) throw upd.error;

      return { submission: sub.data };
    } catch (err) {
      return { error: err.message };
    }
  };

  // Sauvegarder les données d'un formulaire KYC rempli dans kyc_documents
  window.credigoSaveKycFormData = async function(docType, docLabel, stepNumber, formData, pdfBlob) {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };
    try {
      // Sauvegarder le PDF dans Storage si disponible
      var fileUrl = null;
      if (pdfBlob) {
        var path = userId + '/' + docType + '_' + Date.now() + '.pdf';
        var upload = await sb.storage.from('kyc-documents').upload(path, pdfBlob, { upsert: true, contentType: 'application/pdf' });
        if (!upload.error) fileUrl = path;
      }
      // Upsert dans kyc_documents
      var res = await sb.from('kyc_documents').upsert({
        app_user_id: userId,
        doc_type: docType,
        doc_label: docLabel,
        step_number: stepNumber,
        file_url: fileUrl,
        file_name: docType + '_signe.pdf',
        status: 'pending',
        form_data: JSON.stringify(formData),
        uploaded_at: nowIso(),
      }, { onConflict: 'app_user_id,doc_type' }).select().single();
      if (res.error) throw res.error;
      return { success: true, document: res.data };
    } catch(err) {
      return { error: err.message };
    }
  };

  /**
   * Récupère le statut KYC à jour depuis Supabase (pour rafraîchir
   * l'état local après une décision du back-office).
   */
  window.credigoRefreshKycStatus = async function () {
    if (!supabaseReady) return null;
    var userId = currentAppUserId();
    if (!userId) {
      try {
        var authSession = await sb.auth.getSession();
        var email = authSession && authSession.data && authSession.data.session && authSession.data.session.user && authSession.data.session.user.email;
        if (!email) return null;
        var portal = (function() {
          try { var s = JSON.parse(localStorage.getItem('credigo_session') || 'null'); return s ? (s.role === 'e' ? 'entrepreneur' : 'financeur') : null; } catch(e) { return null; }
        })();
        var query = sb.from('app_users').select('id, kyc_status, profile_complete').eq('email', email).is('deleted_at', null);
        if (portal) query = query.eq('portal', portal);
        var res2 = await query.limit(1).single();
        if (res2.error || !res2.data) return null;
        userId = res2.data.id;
        var result2 = res2.data;
        // Récupérer le motif de rejet si rejected
        if (result2.kyc_status === 'rejected') {
          var sub2 = await sb.from('kyc_submissions').select('decision_notes').eq('app_user_id', userId).eq('status', 'rejected').order('reviewed_at', { ascending: false }).limit(1).maybeSingle();
          result2.rejection_reason = (sub2 && sub2.data && sub2.data.decision_notes) || null;
        }
        // Docs rejetés avec motifs
        result2.kyc_resubmit_allowed = result2.kyc_resubmit_allowed || false;
        result2.kyc_required_docs = result2.kyc_required_docs || null;
        result2.kyc_rejected_docs = {};
        try {
          var rj2 = await sb.from('kyc_documents').select('doc_type, rejection_reason').eq('app_user_id', result2.id).eq('status', 'rejected');
          if (!rj2.error && rj2.data) rj2.data.forEach(function(d) { if(d.rejection_reason) result2.kyc_rejected_docs[d.doc_type] = d.rejection_reason; });
        } catch(e) {}
        return result2;
      } catch(e) { return null; }
    }
    var res = await sb.from('app_users').select('kyc_status, profile_complete, kyc_required_docs, kyc_resubmit_allowed, kyc_resubmit_note').eq('id', userId).single();
    if (res.error) return null;
    var result = res.data;
    result.kyc_required_docs = res.data.kyc_required_docs ? [...res.data.kyc_required_docs] : [];
    result.kyc_resubmit_allowed = res.data.kyc_resubmit_allowed || false;
    result.kyc_resubmit_note = res.data.kyc_resubmit_note || null;
    // Récupérer les documents rejetés avec motifs et auto-remplir kyc_required_docs
    try {
      var rejDocs = await sb.from('kyc_documents')
        .select('doc_type, rejection_reason')
        .eq('app_user_id', userId)
        .eq('status', 'rejected');
      if (!rejDocs.error && rejDocs.data) {
        result.kyc_rejected_docs = {};
        rejDocs.data.forEach(function(d) {
          if (d.rejection_reason) result.kyc_rejected_docs[d.doc_type] = d.rejection_reason;
          // Auto-ajouter aux docs requis si pas déjà présent
          if (!result.kyc_required_docs.includes(d.doc_type)) {
            result.kyc_required_docs.push(d.doc_type);
            result.kyc_resubmit_allowed = true;
          }
        });
      } else {
        result.kyc_rejected_docs = {};
      }
    } catch(e) { result.kyc_rejected_docs = {}; }
    // Récupérer le motif de rejet si rejected
    if (result.kyc_status === 'rejected') {
      try {
        var sub = await sb.from('kyc_submissions').select('decision_notes').eq('app_user_id', userId).eq('status', 'rejected').order('reviewed_at', { ascending: false }).limit(1).maybeSingle();
        result.rejection_reason = (sub && sub.data && sub.data.decision_notes) || null;
      } catch(e) { result.rejection_reason = null; }
    }
    return result;
  };

  // ════════════════════════════════════════════════════════════
  // COMPTE ECOBANK — persistance du compte lié
  // ════════════════════════════════════════════════════════════

  window.credigoSaveEcobankAccount = async function (portal, account, name, isExisting) {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };

    var res = await sb
      .from('app_users')
      .update({
        ecobank_account_number: account,
        ecobank_account_holder: name || null,
        ecobank_linked_at: nowIso(),
      })
      .eq('id', userId)
      .select()
      .single();

    if (res.error) return { error: res.error.message };
    return { user: res.data };
  };

  // ════════════════════════════════════════════════════════════
  // SUPPORT — tickets
  // ════════════════════════════════════════════════════════════

  window.credigoCreateTicket = async function (category, subject, message, priority) {
    if (!supabaseReady) return { error: 'Supabase non configuré.' };
    var userId = currentAppUserId();
    if (!userId) return { error: 'Utilisateur non synchronisé.' };

    var res = await sb
      .from('support_tickets')
      .insert({ app_user_id: userId, category: category, subject: subject, message: message, priority: priority || 'normale' })
      .select()
      .single();

    if (res.error) return { error: res.error.message };
    return { ticket: res.data };
  };
})();
