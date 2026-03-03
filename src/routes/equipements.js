const express = require('express');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

function parseDateOnly(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${match[1]}-${match[2]}-${match[3]}`;
}

router.get('/types', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT IdType, NomType, Famille
       FROM TypeEquipement
       ORDER BY Famille ASC, NomType ASC`
    );

    const famillesMap = new Map();

    rows.forEach((row) => {
      if (!famillesMap.has(row.Famille)) {
        famillesMap.set(row.Famille, []);
      }

      famillesMap.get(row.Famille).push({
        idType: row.IdType,
        nomType: row.NomType,
      });
    });

    const familles = Array.from(famillesMap.entries()).map(([famille, types]) => ({
      famille,
      types,
    }));

    return res.json({ success: true, familles });
  } catch (error) {
    console.error('Erreur GET /equipements/types:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.get('/check-numero/:numeroInterne', async (req, res) => {
  try {
    const numeroInterne = String(req.params.numeroInterne || '').trim();

    if (!numeroInterne) {
      return res.status(400).json({ success: false, message: 'NumeroInterne requis.' });
    }

    const [rows] = await pool.execute(
      'SELECT IdEquipement FROM Equipement WHERE NumeroInterne = ? LIMIT 1',
      [numeroInterne]
    );

    return res.json({
      success: true,
      exists: rows.length > 0,
    });
  } catch (error) {
    console.error('Erreur GET /equipements/check-numero:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.get('/types/:idType/config', async (req, res) => {
  try {
    const idType = Number(req.params.idType);
    if (!Number.isInteger(idType) || idType <= 0) {
      return res.status(400).json({ success: false, message: 'IdType invalide.' });
    }

    const [typeRows] = await pool.execute(
      `SELECT IdType, NomType, Famille
       FROM TypeEquipement
       WHERE IdType = ?
       LIMIT 1`,
      [idType]
    );

    if (typeRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Type équipement introuvable.' });
    }

    const type = {
      idType: typeRows[0].IdType,
      nomType: typeRows[0].NomType,
      famille: typeRows[0].Famille,
    };

    const [baseRows] = await pool.execute(
      `SELECT NomChamp, Valeur
       FROM ListeDeroulanteChampBase
       WHERE Famille = ? AND EstActif = 1 AND NomChamp IN ('Localisation', 'Affectation')
       ORDER BY NomChamp ASC, Ordre ASC, Valeur ASC`,
      [type.famille]
    );

    const baseOptions = {
      localisation: [],
      affectation: [],
    };

    for (const row of baseRows) {
      if (row.NomChamp === 'Localisation') {
        baseOptions.localisation.push(row.Valeur);
      }
      if (row.NomChamp === 'Affectation') {
        baseOptions.affectation.push(row.Valeur);
      }
    }

    const [champsRows] = await pool.execute(
      `SELECT IdChamp, NomChamp, TypeDonnees, EstRequisPourAlerte, AfficherDansTableau, UtiliseListeDeroulante
       FROM ChampPersonnalise
       WHERE IdType = ?
       ORDER BY IdChamp ASC`,
      [idType]
    );

    const [placeholderRows] = await pool.execute(
      `SELECT IdChamp, TextePlaceholder
       FROM PlaceholderChamp
       WHERE IdType = ?`,
      [idType]
    );

    const placeholderMap = new Map(
      placeholderRows.map((row) => [row.IdChamp, row.TextePlaceholder || ''])
    );

    const champIds = champsRows.map((row) => row.IdChamp);
    const listeByChamp = new Map();

    if (champIds.length > 0) {
      const placeholders = champIds.map(() => '?').join(',');
      const [listRows] = await pool.execute(
        `SELECT IdChamp, Valeur
         FROM ListeDeroulanteChamp
         WHERE EstActif = 1 AND IdChamp IN (${placeholders})
         ORDER BY IdChamp ASC, Ordre ASC, Valeur ASC`,
        champIds
      );

      for (const row of listRows) {
        if (!listeByChamp.has(row.IdChamp)) {
          listeByChamp.set(row.IdChamp, []);
        }
        listeByChamp.get(row.IdChamp).push(row.Valeur);
      }
    }

    const champs = champsRows.map((row) => ({
      idChamp: row.IdChamp,
      nomChamp: row.NomChamp,
      typeDonnees: row.TypeDonnees,
      estRequisPourAlerte: Boolean(row.EstRequisPourAlerte),
      afficherDansTableau: Boolean(row.AfficherDansTableau),
      utiliseListeDeroulante: Boolean(row.UtiliseListeDeroulante),
      placeholder: placeholderMap.get(row.IdChamp) || '',
      valeursListe: listeByChamp.get(row.IdChamp) || [],
    }));

    return res.json({
      success: true,
      type,
      baseOptions,
      champs,
    });
  } catch (error) {
    console.error('Erreur GET /equipements/types/:idType/config:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.post('/', async (req, res) => {
  let connection;
  try {
    const {
      numeroInterne,
      idType,
      affectation = '',
      localisation = '',
      observations = '',
      customFields = [],
    } = req.body;

    const numeroNettoye = String(numeroInterne || '').trim();
    const idTypeInt = Number(idType);

    if (!numeroNettoye || !Number.isInteger(idTypeInt) || idTypeInt <= 0) {
      return res.status(400).json({
        success: false,
        message: 'numeroInterne et idType valides sont requis.',
      });
    }

    const [existingRows] = await pool.execute(
      'SELECT IdEquipement FROM Equipement WHERE NumeroInterne = ? LIMIT 1',
      [numeroNettoye]
    );

    if (existingRows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Ce numéro interne existe déjà.',
      });
    }

    const [typeRows] = await pool.execute(
      'SELECT IdType FROM TypeEquipement WHERE IdType = ? LIMIT 1',
      [idTypeInt]
    );

    if (typeRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Type équipement introuvable.',
      });
    }

    const famille = typeRows[0].Famille;

    const [champRows] = await pool.execute(
      `SELECT IdChamp, TypeDonnees, EstRequisPourAlerte
       FROM ChampPersonnalise
       WHERE IdType = ?`,
      [idTypeInt]
    );

    const champMap = new Map(champRows.map((row) => [row.IdChamp, row]));
    const customFieldsArray = Array.isArray(customFields) ? customFields : [];

    const today = new Date();
    const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    let status = 'ACTIF';

    const preparedCustomValues = [];

    for (const item of customFieldsArray) {
      const champId = Number(item?.idChamp);
      if (!Number.isInteger(champId) || !champMap.has(champId)) {
        continue;
      }

      const champDef = champMap.get(champId);
      const typeDonnees = String(champDef.TypeDonnees || '').trim();

      let valeurTexte = '';
      let valeurDate = null;
      let valeurNombre = null;

      if (typeDonnees === 'Texte') {
        valeurTexte = String(item?.valeurTexte || '').trim();
      } else if (typeDonnees === 'Date') {
        valeurDate = parseDateOnly(item?.valeurDate);
        if (valeurDate && Boolean(champDef.EstRequisPourAlerte)) {
          const [year, month, day] = valeurDate.split('-').map(Number);
          const champDate = new Date(year, month - 1, day);
          if (champDate < todayOnly) {
            status = 'RETARD';
          }
        }
      } else if (typeDonnees === 'Nombre') {
        const nombreValue = Number(item?.valeurNombre);
        if (Number.isFinite(nombreValue)) {
          valeurNombre = Math.trunc(nombreValue);
        }
      }

      preparedCustomValues.push({
        idChamp: champId,
        valeurTexte,
        valeurDate,
        valeurNombre,
      });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [insertResult] = await connection.execute(
      `INSERT INTO Equipement (NumeroInterne, Affectation, Localisation, Observations, Status, IdType)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [numeroNettoye, affectation, localisation, observations, status, idTypeInt]
    );

    for (const item of preparedCustomValues) {
      await connection.execute(
        `INSERT INTO ValeurChamp (ValeurTexte, ValeurDate, ValeurNombre, IdChamp, IdEquipement)
         VALUES (?, ?, ?, ?, ?)`,
        [item.valeurTexte, item.valeurDate, item.valeurNombre, item.idChamp, insertResult.insertId]
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: 'Équipement ajouté avec succès.',
      equipement: {
        idEquipement: insertResult.insertId,
        numeroInterne: numeroNettoye,
        affectation,
        localisation,
        observations,
        famille,
        status,
        idType: idTypeInt,
      },
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Erreur POST /equipements:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

/**
 * GET /api/equipements/by-numero/:numeroInterne
 * Détail complet d'un équipement via son numéro interne
 */
router.get('/by-numero/:numeroInterne', async (req, res) => {
  try {
    const numeroInterne = String(req.params.numeroInterne || '').trim();

    if (!numeroInterne) {
      return res.status(400).json({ success: false, message: 'NumeroInterne requis.' });
    }

    const [rows] = await pool.execute(
      `SELECT eq.IdEquipement, eq.NumeroInterne, eq.Affectation, eq.Localisation,
              eq.Observations, eq.Status, eq.IdType,
              te.NomType, te.Famille
       FROM Equipement eq
       LEFT JOIN TypeEquipement te ON eq.IdType = te.IdType
       WHERE eq.NumeroInterne = ?
       LIMIT 1`,
      [numeroInterne]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Équipement non trouvé.' });
    }

    const equipement = rows[0];

    const [champsRows] = await pool.execute(
      `SELECT cp.NomChamp, cp.TypeDonnees,
              vc.ValeurTexte, vc.ValeurDate, vc.ValeurNombre
       FROM ValeurChamp vc
       INNER JOIN ChampPersonnalise cp ON vc.IdChamp = cp.IdChamp
       WHERE vc.IdEquipement = ?
       ORDER BY cp.IdChamp ASC`,
      [equipement.IdEquipement]
    );

    const champsPersonnalises = champsRows.map((row) => {
      let valeur = '';
      if (row.TypeDonnees === 'Date' && row.ValeurDate) {
        const d = new Date(row.ValeurDate);
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        valeur = `${day}/${month}/${year}`;
      } else if (row.TypeDonnees === 'Nombre' && row.ValeurNombre !== null) {
        valeur = String(row.ValeurNombre);
      } else {
        valeur = row.ValeurTexte || '';
      }
      return {
        nomChamp: row.NomChamp,
        typeDonnees: row.TypeDonnees,
        valeur,
      };
    });

    return res.json({
      success: true,
      equipement: {
        ...equipement,
        champsPersonnalises,
      },
    });
  } catch (error) {
    console.error('Erreur GET /equipements/by-numero/:numeroInterne:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

/**
 * PUT /api/equipements/validite/by-numero/:numeroInterne
 * Met à jour une date de validité d'un équipement via scan
 */
router.put('/validite/by-numero/:numeroInterne', async (req, res) => {
  let connection;
  try {
    const numeroInterne = String(req.params.numeroInterne || '').trim();
    const idType = Number(req.body?.idType);
    const idChampDate = Number(req.body?.idChampDate);
    const dateValidite = parseDateOnly(req.body?.dateValidite);

    if (!numeroInterne) {
      return res.status(400).json({ success: false, message: 'NumeroInterne requis.' });
    }

    if (!Number.isInteger(idType) || idType <= 0) {
      return res.status(400).json({ success: false, message: 'idType invalide.' });
    }

    if (!Number.isInteger(idChampDate) || idChampDate <= 0) {
      return res.status(400).json({ success: false, message: 'idChampDate invalide.' });
    }

    if (!dateValidite) {
      return res.status(400).json({ success: false, message: 'dateValidite invalide (format attendu YYYY-MM-DD).' });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [equipementRows] = await connection.execute(
      `SELECT IdEquipement, NumeroInterne, IdType
       FROM Equipement
       WHERE NumeroInterne = ?
       LIMIT 1`,
      [numeroInterne]
    );

    if (equipementRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Équipement non trouvé.' });
    }

    const equipement = equipementRows[0];

    if (Number(equipement.IdType) !== idType) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Le type sélectionné ne correspond pas à cet équipement.',
      });
    }

    const [champRows] = await connection.execute(
      `SELECT IdChamp, NomChamp, TypeDonnees
       FROM ChampPersonnalise
       WHERE IdChamp = ? AND IdType = ?
       LIMIT 1`,
      [idChampDate, idType]
    );

    if (champRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Champ de date introuvable pour ce type.' });
    }

    const champ = champRows[0];
    if (String(champ.TypeDonnees || '').trim() !== 'Date') {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Le champ sélectionné n’est pas un champ date.' });
    }

    const [valeurRows] = await connection.execute(
      `SELECT IdValeur
       FROM ValeurChamp
       WHERE IdEquipement = ? AND IdChamp = ?
       LIMIT 1`,
      [equipement.IdEquipement, idChampDate]
    );

    if (valeurRows.length > 0) {
      await connection.execute(
        `UPDATE ValeurChamp
         SET ValeurDate = ?, ValeurTexte = '', ValeurNombre = NULL
         WHERE IdValeur = ?`,
        [dateValidite, valeurRows[0].IdValeur]
      );
    } else {
      await connection.execute(
        `INSERT INTO ValeurChamp (ValeurTexte, ValeurDate, ValeurNombre, IdChamp, IdEquipement)
         VALUES ('', ?, NULL, ?, ?)`,
        [dateValidite, idChampDate, equipement.IdEquipement]
      );
    }

    const [statusRows] = await connection.execute(
      `SELECT cp.EstRequisPourAlerte, vc.ValeurDate
       FROM ChampPersonnalise cp
       LEFT JOIN ValeurChamp vc
         ON vc.IdChamp = cp.IdChamp AND vc.IdEquipement = ?
       WHERE cp.IdType = ? AND cp.TypeDonnees = 'Date' AND cp.EstRequisPourAlerte = 1`,
      [equipement.IdEquipement, idType]
    );

    const now = new Date();
    const todayOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let status = 'ACTIF';

    for (const row of statusRows) {
      if (!row.ValeurDate) {
        continue;
      }
      const d = new Date(row.ValeurDate);
      const dateOnly = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      if (dateOnly < todayOnly) {
        status = 'RETARD';
        break;
      }
    }

    await connection.execute(
      'UPDATE Equipement SET Status = ? WHERE IdEquipement = ?',
      [status, equipement.IdEquipement]
    );

    await connection.commit();

    return res.json({
      success: true,
      message: 'Date de validité mise à jour.',
      data: {
        numeroInterne: equipement.NumeroInterne,
        idType,
        idChampDate,
        nomChampDate: champ.NomChamp,
        dateValidite,
        status,
      },
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Erreur PUT /equipements/validite/by-numero/:numeroInterne:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

/**
 * GET /api/equipements/search?q=...
 * Recherche simple multi-champs d'équipements
 */
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();

    if (!q) {
      return res.json({ success: true, results: [] });
    }

    const like = `%${q}%`;

    const [rows] = await pool.execute(
      `SELECT eq.IdEquipement, eq.NumeroInterne, eq.Affectation, eq.Localisation,
              eq.Observations, eq.Status,
              te.NomType, te.Famille
       FROM Equipement eq
       LEFT JOIN TypeEquipement te ON te.IdType = eq.IdType
       WHERE eq.NumeroInterne LIKE ?
          OR te.NomType LIKE ?
          OR te.Famille LIKE ?
          OR eq.Affectation LIKE ?
          OR eq.Localisation LIKE ?
          OR eq.Observations LIKE ?
       ORDER BY eq.NumeroInterne ASC
       LIMIT 50`,
      [like, like, like, like, like, like]
    );

    return res.json({
      success: true,
      results: rows.map((row) => ({
        idEquipement: row.IdEquipement,
        numeroInterne: row.NumeroInterne,
        nomType: row.NomType,
        famille: row.Famille,
        affectation: row.Affectation,
        localisation: row.Localisation,
        observations: row.Observations,
        status: row.Status,
      })),
    });
  } catch (error) {
    console.error('Erreur GET /equipements/search:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

/**
 * GET /api/equipements/:id
 * Détail complet d'un équipement avec tous ses champs personnalisés
 */
router.get('/:id', async (req, res) => {
  try {
    const equipementId = Number(req.params.id);
    if (!Number.isInteger(equipementId) || equipementId <= 0) {
      return res.status(400).json({ success: false, message: 'Id invalide.' });
    }

    const [rows] = await pool.execute(
      `SELECT eq.IdEquipement, eq.NumeroInterne, eq.Affectation, eq.Localisation,
              eq.Observations, eq.Status, eq.IdType,
              te.NomType, te.Famille
       FROM Equipement eq
       LEFT JOIN TypeEquipement te ON eq.IdType = te.IdType
       WHERE eq.IdEquipement = ?
       LIMIT 1`,
      [equipementId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Équipement non trouvé.' });
    }

    const equipement = rows[0];

    // Récupérer tous les champs personnalisés avec leurs valeurs
    const [champsRows] = await pool.execute(
      `SELECT cp.NomChamp, cp.TypeDonnees,
              vc.ValeurTexte, vc.ValeurDate, vc.ValeurNombre
       FROM ValeurChamp vc
       INNER JOIN ChampPersonnalise cp ON vc.IdChamp = cp.IdChamp
       WHERE vc.IdEquipement = ?
       ORDER BY cp.IdChamp ASC`,
      [equipementId]
    );

    const champsPersonnalises = champsRows.map((row) => {
      let valeur = '';
      if (row.TypeDonnees === 'Date' && row.ValeurDate) {
        const d = new Date(row.ValeurDate);
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        valeur = `${day}/${month}/${year}`;
      } else if (row.TypeDonnees === 'Nombre' && row.ValeurNombre !== null) {
        valeur = String(row.ValeurNombre);
      } else {
        valeur = row.ValeurTexte || '';
      }
      return {
        nomChamp: row.NomChamp,
        typeDonnees: row.TypeDonnees,
        valeur,
      };
    });

    return res.json({
      success: true,
      equipement: {
        ...equipement,
        champsPersonnalises,
      },
    });
  } catch (error) {
    console.error('Erreur GET /equipements/:id:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;
