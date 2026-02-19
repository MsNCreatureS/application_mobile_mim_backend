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

module.exports = router;
