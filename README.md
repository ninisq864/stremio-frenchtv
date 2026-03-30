# 🏆 FRENCH-TV Sport — Addon Stremio

## Installation rapide

### 1. Installe Node.js
Télécharge sur https://nodejs.org (version LTS)

### 2. Lance l'addon
Ouvre un terminal dans ce dossier et tape :
```
npm install
npm start
```

### 3. Configure tes identifiants
Ouvre le fichier `src/index.js` et remplace :
- `proxy_user` → ton vrai username FRENCH-TV
- `proxy_password` → ton vrai mot de passe FRENCH-TV

Ces infos sont visibles dans HTTP Toolkit dans l'URL :
https://iptv.vdfr.co.uk/live/USERNAME/PASSWORD/...

### 4. Ajoute dans Stremio
Dans Stremio → Paramètres → Addons → Addon communautaire :
```
http://localhost:7000/manifest.json
```

## Auto-sync
Les flux se mettent à jour automatiquement toutes les 5 minutes.
Si FRENCH-TV change ses flux, Stremio se met à jour sans rien faire. ✅
