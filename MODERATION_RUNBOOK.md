# Moderation Runbook — StibAlert Community System

**Audience:** Modérateurs StibAlert · Owner technique: Backend Lead
**Dernière révision:** 2026-05-12

---

## 🚨 Quand intervenir

### Alerte automatique (à venir dans email/Slack)
- Queue > 50 items pending
- Item en attente > 4h
- Pic spam : >20 flags système en 1h

### Routine quotidienne
- **Matin (~9h)**: scan queue, traiter high priority
- **Soir (~18h)**: scan queue, traiter normal priority

**SLO**:
- High priority (offensive, spam élevé): traité < 2h
- Normal priority: traité < 24h
- Low priority (auto-aged): traité < 48h

---

## 🔑 Accès au dashboard

1. Ouvrir `https://stibalert-backend.example.com/admin/moderation/`
2. Coller votre **JWT admin** dans le champ "Admin Token" (récupérable via `/api/utilisateurs/connexion`)
3. Le token est sauvegardé en localStorage (re-saisir si navigateur changé)

### Créer un compte admin

```bash
# Sur le serveur (Mongo shell ou Compass):
db.utilisateurs.updateOne(
  { email: "mod@example.com" },
  { $set: { role: "Admin" } }
);
```

Ou via le script (cf. `scripts/promoteAdmin.js`).

---

## 🧠 Décider de l'action

Pour chaque signalement flaggé, regardez :

1. **Description** : insulte / URL spam / contenu hors sujet ?
2. **Ligne et arrêt** : cohérents géographiquement ?
3. **Score spam** : >85 = probable spam, <50 = probable faux positif
4. **Motifs** : `url_detected`, `rapid_fire`, `duplicate_same_device`, `geographic_outlier`, `offensive_keywords`

### Arbre de décision

```
Le signalement est-il un VRAI signalement transit ?
├── OUI → APPROUVER (le retire de la queue, garde visible)
│       Exemple: "Tram 56 retarde de 15 min" flagged à tort
│
├── NON, mais innocent (test, erreur utilisateur)
│   → REJETER (retire de la queue, garde signalement visible)
│       Exemple: utilisateur a tapé n'importe quoi par curiosité
│
├── OUI mais avec contenu inapproprié (insulte dans description)
│   → ESCALADER (pour décision senior)
│       Exemple: signalement légitime mais avec insulte
│
└── NON, c'est du spam / abus
    → REMOVE (cache + ban device 24h)
        Exemple: pub, URL malveillante, contenu offensant
```

---

## 🎯 Actions disponibles

| Action | Effet sur signalement | Effet sur cluster | Effet sur device |
|---|---|---|---|
| **Approuver** | reste visible | continue cluster | aucun |
| **Rejeter** | reste visible | continue cluster | aucun |
| **Remove** | status="spam", caché | retiré du cluster | +1 flag, ban 24h après 10 flags |
| **Escalader** | inchangé | inchangé | aucun |

---

## 🛑 Cas spéciaux

### Spam massif (même device, même contenu)
1. Filtrer queue par device dans signalementSnapshot.reporterDeviceHash
2. Action **Remove** sur tous → ban auto déclenché
3. Si récidive : ban manuel permanent (cf. `scripts/banDevice.js`)

### Faux positif systématique
Si un type de signalement légitime est régulièrement flaggé :
1. Noter dans channel #moderation
2. Backend Lead ajuste les seuils `SPAM_SCORE_FLAG_THRESHOLD`
3. Pas d'action utilisateur nécessaire

### Compte authentifié signalant n'importe quoi
1. **Remove** ses signalements
2. Si récidive >5 fois en 7 jours : noter sur Discord, escalader
3. Suspension compte via :
   ```bash
   db.utilisateurs.updateOne(
     { _id: ObjectId("...") },
     { $set: { suspendu: true, suspenduJusqu: new Date(Date.now() + 7*86400*1000) } }
   );
   ```

### Demande RGPD (export/suppression)
- L'utilisateur a un endpoint dans l'app : Profil → Confidentialité
- Si demande email à privacy@stib-alert.be :
  1. Vérifier identité (email correspond au compte)
  2. Donner instruction d'utiliser l'endpoint
  3. Si impossible : exécuter manuellement (cf. `scripts/rgpdManual.js`)

---

## 📊 Stats à surveiller

```
GET /admin/moderation/summary
{
  "pending": 23,
  "breakdown": { "high": 2, "normal": 18, "low": 3 },
  "oldestFlaggedAt": "2026-05-12T08:30:00Z"
}
```

**Seuils d'alerte** :
- pending > 50 → renforcer modération
- oldest > 4h → priorité immédiate
- breakdown.high > 5 → escalation senior

---

## 🚀 Procédure en cas de pic

1. **Identifier** : un seul device responsable ? Une ligne particulière ?
2. **Si bot** :
   - Filtrer queue par device hash
   - Bulk Remove
   - Ban auto déclenché
3. **Si campagne coordonnée** :
   - Désactiver temporairement signalements anonymes :
     ```bash
     # Bump min trust requis dans services/clusterService.js
     # MIN_TRUST_TO_PUBLISH = 75 (au lieu de 50)
     ```
   - Notifier équipe sur #incidents
4. **Si app défaillante** (flags légitimes par erreur) :
   - Rollback dernier déploiement
   - `git revert HEAD && git push`

---

## 📞 Escalation

| Niveau | Quand | Contact |
|---|---|---|
| L1 (mod) | Cas courant | Vous |
| L2 (senior) | Contenu sensible (haine, mineurs) | Achraf Benali |
| L3 (légal) | Demande judiciaire, doxing | privacy@stib-alert.be |

---

## 🧪 Test du dashboard

Avant d'agir en prod, tester sur staging :

1. Créer 5 signalements spam :
   ```bash
   for i in 1 2 3 4 5; do
     curl -X POST https://staging.stibalert.be/api/signalements \
       -H "Content-Type: application/json" \
       -H "x-stib-device-id: test-spam-$i" \
       -d '{"nomArret":"Test","ligne":"56","typeProbleme":"Retard","description":"Visit http://spam.com"}'
   done
   ```

2. Vérifier qu'ils apparaissent en queue
3. Tester chaque action
4. Vérifier que Remove ban bien le device après 10 flags

---

## ✅ Checklist avant launch (27 mai)

- [ ] 2 comptes admin créés (Achraf + backup)
- [ ] Test dashboard live OK
- [ ] Test ban device OK
- [ ] Test approve/reject/remove OK
- [ ] Slack/email alertes configurées (out of scope MVP, manuel)
- [ ] Runbook lu par tous les mods
- [ ] Stats baseline notée (queue ~0 au launch)

---

## 📝 Glossaire

- **Cluster** : Groupe de 3+ signalements similaires sur (ligne, arrêt, type)
- **Trust score** : 0-100, basé sur user/guest + device history
- **Spam score** : 0-100, calculé à la création (URL, similarité, géo, rapid-fire)
- **Flag** : Item dans la queue, peut être system (auto-spam) ou user (bouton "Signaler offensant")
- **Device hash** : SHA256(device-id + salt), jamais raw
