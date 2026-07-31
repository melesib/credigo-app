/* ═══════════════════════════════════════════════════════════════
   Credigo — Module de support pour les portails partenaires
   Utilisé par portail.html (donneur) et banque-portail.html (banque).
   Fournit : liste des fils, ouverture d'une demande, réponse, suivi.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  window.CredigoSupport = {
    /**
     * Compte les fils en attente du partenaire, sans rien afficher.
     * Sert à alimenter la pastille dès l'ouverture du portail.
     */
    count: function (opts) {
      return opts.sb.rpc('get_partner_tickets', {
        p_type: opts.type, p_code: opts.code, p_session_token: opts.getSession(),
      }).then(function (res) {
        var d = res.data || {};
        if (d.error) return 0;
        return (d.items || []).filter(function (t) {
          return t.status === 'waiting_partner' || t.unread;
        }).length;
      }, function () { return 0; });
    },

    /**
     * Initialise le module de support.
     * @param {object} opts
     *   sb            : client Supabase
     *   type          : 'donneur' | 'banque'
     *   code          : code portail
     *   getSession    : fonction renvoyant le jeton de session
     *   containerId   : id du conteneur où afficher
     *   onBadge       : callback(nbEnAttente) pour la pastille
     */
    init: function (opts) {
      var sb = opts.sb, type = opts.type, code = opts.code;
      var getSession = opts.getSession;
      var box = document.getElementById(opts.containerId);
      var onBadge = opts.onBadge || function () {};
      if (!box) return;

      var tickets = [];
      var openThreadId = null;

      function esc(s) {
        return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) {
          return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c];
        });
      }
      function dateFr(d) {
        if (!d) return '';
        try {
          return new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })
            + ' ' + new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        } catch (e) { return ''; }
      }
      function statusLabel(s) {
        return { open: 'Ouvert', waiting_partner: 'Votre réponse attendue',
                 waiting_credigo: 'En attente de Credigo', resolved: 'Résolu',
                 closed: 'Clôturé' }[s] || s;
      }
      function statusColor(s) {
        if (s === 'waiting_partner') return { bg: '#FEE2E2', c: '#B91C1C' };
        if (s === 'waiting_credigo') return { bg: '#FEF3C7', c: '#B45309' };
        if (s === 'resolved' || s === 'closed') return { bg: '#DCFCE7', c: '#15803D' };
        return { bg: '#E0E7FF', c: '#3730A3' };
      }

      function load() {
        box.innerHTML = '<div style="text-align:center;padding:24px;color:#9CA3AF">Chargement…</div>';
        sb.rpc('get_partner_tickets', {
          p_type: type, p_code: code, p_session_token: getSession(),
        }).then(function (res) {
          var d = res.data || {};
          if (d.error) { box.innerHTML = '<div style="text-align:center;padding:24px;color:#9CA3AF">Support indisponible.</div>'; return; }
          tickets = d.items || [];
          onBadge(tickets.filter(function (t) { return t.status === 'waiting_partner' || t.unread; }).length);
          renderList();
        }, function () {
          box.innerHTML = '<div style="text-align:center;padding:24px;color:#9CA3AF">Connexion impossible.</div>';
        });
      }

      function renderList() {
        var html = '<button id="sup-new" style="width:100%;padding:12px;border-radius:10px;border:none;background:#6C3FE8;color:#fff;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;margin-bottom:12px">'
          + '<i class="ti ti-plus"></i> Écrire au support Credigo</button>'
          + '<div id="sup-form" class="hide" style="background:#fff;border-radius:12px;padding:14px;margin-bottom:12px;box-shadow:0 4px 16px rgba(76,29,149,.07)">'
          + '<label style="font-size:11.5px;font-weight:700;color:#4B5563;display:block">Objet</label>'
          + '<input type="text" id="sup-subject" placeholder="Objet de votre demande" style="width:100%;padding:10px;border:1px solid #E5E7EB;border-radius:9px;font-size:13px;font-family:inherit;margin-top:4px">'
          + '<label style="font-size:11.5px;font-weight:700;color:#4B5563;display:block;margin-top:8px">Votre message</label>'
          + '<textarea id="sup-body" rows="4" placeholder="Décrivez votre demande…" style="width:100%;padding:10px;border:1px solid #E5E7EB;border-radius:9px;font-size:13px;font-family:inherit;margin-top:4px;resize:vertical"></textarea>'
          + '<label style="font-size:11.5px;font-weight:700;color:#4B5563;display:block;margin-top:8px">Votre nom</label>'
          + '<input type="text" id="sup-author" placeholder="Nom du contact" style="width:100%;padding:10px;border:1px solid #E5E7EB;border-radius:9px;font-size:13px;font-family:inherit;margin-top:4px">'
          + '<button id="sup-send" style="width:100%;padding:11px;border-radius:10px;border:none;background:#15803D;color:#fff;font-weight:800;font-size:13px;cursor:pointer;font-family:inherit;margin-top:10px">Envoyer</button>'
          + '<div id="sup-err" style="font-size:12px;color:#B91C1C;font-weight:700;margin-top:6px"></div></div>';

        if (!tickets.length) {
          html += '<div style="text-align:center;padding:24px;color:#9CA3AF;font-size:13px">Aucun échange pour le moment.</div>';
        } else {
          tickets.forEach(function (t) {
            var sc = statusColor(t.status);
            html += '<div class="sup-card" data-id="' + t.id + '" style="background:#fff;border-radius:12px;padding:13px;margin-bottom:9px;box-shadow:0 4px 16px rgba(76,29,149,.07);cursor:pointer'
              + (t.status === 'waiting_partner' || t.unread ? ';border-left:4px solid #DC2626' : '') + '">'
              + '<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">'
              +   '<div style="font-size:14px;font-weight:800;color:#111827">' + (t.unread ? '<span style="color:#DC2626">\u25cf </span>' : '') + esc(t.subject) + '</div>'
              +   '<span style="font-size:10px;font-weight:800;padding:3px 8px;border-radius:20px;white-space:nowrap;background:' + sc.bg + ';color:' + sc.c + '">' + statusLabel(t.status) + '</span>'
              + '</div>'
              + (t.contract_number ? '<div style="font-family:monospace;font-size:11px;color:#6C3FE8;font-weight:700;margin-top:2px">' + esc(t.contract_number) + '</div>' : '')
              + '<div style="font-size:11.5px;color:#6B7280;margin-top:5px">'
              +   (t.nb_messages || 0) + ' message' + ((t.nb_messages || 0) > 1 ? 's' : '')
              +   ' · ' + dateFr(t.last_message_at)
              +   (t.waiting_hours != null && t.status === 'waiting_partner' ? ' · en attente depuis ' + t.waiting_hours + ' h' : '')
              + '</div></div>';
          });
        }
        box.innerHTML = html;
        attach();
      }

      function attach() {
        var nw = document.getElementById('sup-new');
        if (nw) nw.addEventListener('click', function () {
          var f = document.getElementById('sup-form');
          f.classList.toggle('hide');
        });
        var send = document.getElementById('sup-send');
        if (send) send.addEventListener('click', function () { postNew(send); });
        Array.prototype.forEach.call(box.querySelectorAll('.sup-card'), function (c) {
          c.addEventListener('click', function () { openThread(c.dataset.id); });
        });
      }

      function postNew(btn) {
        var subject = (document.getElementById('sup-subject') || {}).value || '';
        var body = (document.getElementById('sup-body') || {}).value || '';
        var author = (document.getElementById('sup-author') || {}).value || '';
        var err = document.getElementById('sup-err');
        if (!body.trim()) { err.textContent = 'Écrivez votre message.'; return; }
        err.textContent = ''; btn.disabled = true; btn.textContent = 'Envoi…';
        sb.rpc('partner_post_message', {
          p_type: type, p_code: code, p_session_token: getSession(),
          p_ticket_id: null, p_subject: subject.trim() || null, p_body: body.trim(),
          p_category: 'general', p_author_name: author.trim() || null,
          p_ip: window.__clientIp || null,
        }).then(function (res) {
          btn.disabled = false; btn.textContent = 'Envoyer';
          var d = res.data || {};
          if (d.ok) { load(); }
          else { err.textContent = 'Envoi impossible. Réessayez.'; }
        }, function () { btn.disabled = false; btn.textContent = 'Envoyer'; err.textContent = 'Connexion impossible.'; });
      }

      function openThread(id) {
        openThreadId = id;
        box.innerHTML = '<div style="text-align:center;padding:24px;color:#9CA3AF">Chargement…</div>';
        // Trace la lecture (non bloquant) : Credigo saura que le fil a été ouvert.
        sb.rpc('track_partner_ticket_open', {
          p_type: type, p_code: code, p_session_token: getSession(), p_ticket_id: id,
        }).then(function (r) {
          var e = r && r.data && r.data.error;
          if (e) console.warn('Suivi de lecture refusé :', e);
          if (r && r.error) console.warn('Suivi de lecture indisponible :', r.error.message);
        }, function (err) { console.warn('Suivi de lecture impossible :', err); });
        sb.rpc('get_partner_ticket_thread', {
          p_type: type, p_code: code, p_session_token: getSession(), p_ticket_id: id,
        }).then(function (res) {
          var d = res.data || {};
          if (d.error) { box.innerHTML = '<div style="padding:20px;color:#9CA3AF">Fil indisponible.</div>'; return; }
          renderThread(d);
        }, function () { box.innerHTML = '<div style="padding:20px;color:#9CA3AF">Connexion impossible.</div>'; });
      }

      function renderThread(d) {
        var closed = d.status === 'resolved' || d.status === 'closed';
        var sc = statusColor(d.status);
        var html = '<button id="sup-back" style="background:none;border:none;color:#6C3FE8;font-weight:700;font-size:13px;cursor:pointer;padding:0;margin-bottom:10px;font-family:inherit">← Retour aux échanges</button>'
          + '<div style="background:#fff;border-radius:12px;padding:14px;box-shadow:0 4px 16px rgba(76,29,149,.07)">'
          + '<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:10px">'
          +   '<div style="font-size:15px;font-weight:800">' + esc(d.subject) + '</div>'
          +   '<span style="font-size:10px;font-weight:800;padding:3px 8px;border-radius:20px;white-space:nowrap;background:' + sc.bg + ';color:' + sc.c + '">' + statusLabel(d.status) + '</span>'
          + '</div>';

        (d.messages || []).forEach(function (m) {
          var mine = m.side === 'partner';
          html += '<div style="margin-bottom:10px;display:flex;' + (mine ? 'justify-content:flex-end' : '') + '">'
            + '<div style="max-width:85%;background:' + (mine ? '#F5F3FF' : '#F9FAFB') + ';border:1px solid ' + (mine ? '#DDD6FE' : '#F3F4F6') + ';border-radius:11px;padding:10px 12px">'
            +   '<div style="font-size:11px;font-weight:800;color:' + (mine ? '#6C3FE8' : '#6B7280') + ';margin-bottom:3px">' + esc(m.author || (mine ? 'Vous' : 'Credigo')) + '</div>'
            +   '<div style="font-size:13px;color:#111827;white-space:pre-wrap;line-height:1.5">' + esc(m.body) + '</div>'
            +   '<div style="font-size:10.5px;color:#9CA3AF;margin-top:4px">' + dateFr(m.created_at) + '</div>'
            + '</div></div>';
        });

        if (!closed) {
          html += '<div style="border-top:1px solid #F3F4F6;padding-top:10px;margin-top:6px">'
            + '<textarea id="sup-reply" rows="3" placeholder="Votre réponse…" style="width:100%;padding:10px;border:1px solid #E5E7EB;border-radius:9px;font-size:13px;font-family:inherit;resize:vertical"></textarea>'
            + '<input type="text" id="sup-reply-author" placeholder="Votre nom" style="width:100%;padding:9px;border:1px solid #E5E7EB;border-radius:9px;font-size:12.5px;font-family:inherit;margin-top:6px">'
            + '<button id="sup-reply-send" style="width:100%;padding:11px;border-radius:10px;border:none;background:#6C3FE8;color:#fff;font-weight:800;font-size:13px;cursor:pointer;font-family:inherit;margin-top:8px">Répondre</button>'
            + '<div id="sup-reply-err" style="font-size:12px;color:#B91C1C;font-weight:700;margin-top:6px"></div></div>';
        } else {
          html += '<div style="font-size:12.5px;color:#15803D;font-weight:700;text-align:center;padding:10px">Cet échange est clôturé.</div>';
        }
        html += '</div>';
        box.innerHTML = html;

        document.getElementById('sup-back').addEventListener('click', load);
        var rs = document.getElementById('sup-reply-send');
        if (rs) rs.addEventListener('click', function () {
          var body = (document.getElementById('sup-reply') || {}).value || '';
          var author = (document.getElementById('sup-reply-author') || {}).value || '';
          var err = document.getElementById('sup-reply-err');
          if (!body.trim()) { err.textContent = 'Écrivez votre réponse.'; return; }
          err.textContent = ''; rs.disabled = true; rs.textContent = 'Envoi…';
          sb.rpc('partner_post_message', {
            p_type: type, p_code: code, p_session_token: getSession(),
            p_ticket_id: openThreadId, p_subject: null, p_body: body.trim(),
            p_category: null, p_author_name: author.trim() || null,
            p_ip: window.__clientIp || null,
          }).then(function (res) {
            rs.disabled = false; rs.textContent = 'Répondre';
            if (res.data && res.data.ok) openThread(openThreadId);
            else err.textContent = 'Envoi impossible.';
          }, function () { rs.disabled = false; rs.textContent = 'Répondre'; err.textContent = 'Connexion impossible.'; });
        });
      }

      this.reload = load;
      load();
      return { reload: load };
    },
  };
})();
