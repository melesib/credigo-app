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
      // Si email fourni, chercher par email
      if (email) {
        var q = sb.from('app_users')
          .select('id, kyc_status, profile_complete')
          .eq('email', email)
          .is('deleted_at', null);
        if (portal) q = q.eq('portal', portal === 'e' ? 'entrepreneur' : 'financeur');
        var r = await q.limit(1).maybeSingle();
        if (r.error || !r.data) return null;
        var data = r.data;
        if (data.kyc_status === 'rejected') {
          var sub = await sb.from('kyc_submissions')
            .select('decision_notes')
            .eq('app_user_id', data.id)
            .eq('status', 'rejected')
            .order('reviewed_at', { ascending: false })
            .limit(1).maybeSingle();
          data.rejection_reason = (sub && sub.data && sub.data.decision_notes) || null;
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
        if (inserted.error) throw inserted.error;
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

  // ════════════════════════════════════════════════════════════
  // KYC — upload de document vers Supabase Storage + ligne DB
  // ════════════════════════════════════════════════════════════

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
        return result2;
      } catch(e) { return null; }
    }
    var res = await sb.from('app_users').select('kyc_status, profile_complete, kyc_required_docs, kyc_resubmit_allowed, kyc_resubmit_note').eq('id', userId).single();
    if (res.error) return null;
    var result = res.data;
    result.kyc_required_docs = res.data.kyc_required_docs || null;
    result.kyc_resubmit_allowed = res.data.kyc_resubmit_allowed || false;
    result.kyc_resubmit_note = res.data.kyc_resubmit_note || null;
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
