# Application Mobile MIM - Backend

Backend Node.js/Express pour l'application mobile MIM.

## Installation

```bash
npm install
```

## Configuration

Créer un fichier `.env` à la racine :

```
DB_HOST=interchange.proxy.rlwy.net
DB_PORT=26474
DB_NAME=MIM_Logiciel
DB_USER=root
DB_PASSWORD=votre_mot_de_passe
PORT=3001
JWT_SECRET=votre_secret_jwt
```

## Lancement

```bash
# Développement
npm run dev

# Production
npm start
```

## API Endpoints

- `POST /api/auth/login` - Connexion (email + password)
- `GET /api/auth/me` - Infos utilisateur connecté (Bearer token)
- `GET /api/health` - Health check
