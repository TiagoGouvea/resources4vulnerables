import db from '../schemas';
import path from 'path';
import fs from 'fs';
import Sequelize from 'sequelize';
import csv from 'csvtojson';
import deburr from 'lodash/deburr';
import uniqBy from 'lodash/uniqBy';
import { createObjectCsvWriter } from 'csv-writer';
import { getFamilyGroupByCode } from '../utils/constraints';
import moment from 'moment';
import logging from '../utils/logging';
import { compareNames } from '../utils/string';
import { parseFamilyAndSislameItems, certifyDependentsByFamilyList } from './dependents';

import { FamilyItem, SislameItem, OriginalSislameItem } from '../typings/filesItems';
import { Family, SequelizeFamily } from '../schemas/families';
import { City } from '../schemas/cities';

type ImportReport = {
  status: 'idle' | 'completed' | 'failed' | 'reading files' | 'filtering data' | 'saving' | 'comparing data';
  message?: string;
  percentage?: number;
  cityId?: NonNullable<City['id']>;
  inProgress?: boolean;
};

// Global report
const importReportList: ImportReport[] = [];

const csvWriterList: { [key: string]: ReturnType<typeof createObjectCsvWriter> } = {};

/**
 * Get or create CSV Writer for the the city
 * @param cityId logged user unique ID
 * @returns CSV Writer instance
 */
export const getCSVWriter = (cityId: NonNullable<City['id']>) => {
  if (!csvWriterList[cityId]) {
    const filePath = `${path.dirname(__dirname)}/../database/storage/reason_${cityId}.csv`;
    // Create file
    fs.writeFileSync(filePath, undefined);
    // Create object csv writer - using the same writer will edit the same file
    csvWriterList[cityId] = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: 'UF', title: 'UF' },
        { id: 'MUNICIPIO', title: 'MUNICIPIO' },
        { id: 'TITULAR', title: 'TITULAR' },
        { id: 'DTNASCTIT', title: 'DTNASCTIT' },
        { id: 'NISTITULAR', title: 'NISTITULAR' },
        { id: 'COMPETFOLHA', title: 'COMPETFOLHA' },
        { id: 'SITFAM', title: 'SITFAM' },
        { id: 'NISDEPENDEN', title: 'NISDEPENDEN' },
        { id: 'DEPENDENTE', title: 'DEPENDENTE' },
        { id: 'IDADE', title: 'IDADE' },
        { id: 'DTNASCDEP', title: 'DTNASCDEP' },
        { id: 'QTDE. MEMBROS', title: 'QTDE. MEMBROS' },
        { id: 'reason', title: 'MOTIVO' }
      ]
    });
  }
  return csvWriterList[cityId];
};

/**
 * Remove city CSV Writer from the list
 * @param cityId logged user unique ID
 */
export const removeCSVWriter = (cityId: NonNullable<City['id']>) => {
  delete csvWriterList[cityId];
};

/**
 * Get current report for the city
 * @param cityId logged user city unique ID
 * @returns ImportReport
 */
export const getImportReport = (cityId: NonNullable<City['id']>): ImportReport => {
  const importReport = importReportList.find((item) => item.cityId === cityId);
  if (!importReport) return { status: 'idle', cityId, inProgress: false };
  return importReport;
};

/**
 * Update current report for the city
 * @param importReport new import report data
 * @param cityId logged user city unique ID
 */
export const updateImportReport = (importReport: ImportReport, cityId: NonNullable<City['id']>) => {
  const index = importReportList.findIndex((item) => item.cityId === cityId);
  if (index > -1) {
    // Removing if already exists
    importReportList.splice(index, 1);
  }
  const inProgress = importReport.inProgress !== undefined ? importReport.inProgress : true;
  importReportList.push({ ...importReport, cityId, inProgress });
};

/**
 * Get all items on the table without any filter
 * @param nis searched nis code
 * @param cityId logged user city ID
 * @returns Promise<List of items>
 */
export const findByNis = async (
  nis: NonNullable<Family['responsibleNis']>,
  cityId: NonNullable<City['id']>
): Promise<SequelizeFamily> => {
  const [family] = await db.families.findAll({ where: { responsibleNis: nis, cityId }, limit: 1 });
  return family;
};

type CSVReport = {
  created: number;
  updated: number;
  deleted: number;
  wrong: number;
  report: string[];
  finished: boolean;
};

/**
 * Create or update family by Family Code
 * @param family Family Object
 */
export const certifyFamilyByCode = async (family: Family) => {
  const [createdFamily, created] = await db.families.findCreateFind({ where: { code: family.code }, defaults: family });
  if (!created) {
    // Just update the family with the new data
    const [, [item]] = await db.families.update(family, { where: { id: createdFamily.id as number }, returning: true });
    return item;
  } else {
    // Family was created
    return createdFamily;
  }
};

/**
 * Create or update family by Responsible NIS
 * @param family Family Object
 */
export const certifyFamilyByNis = async (family: Family) => {
  const [createdFamily, created] = await db.families.findCreateFind({
    where: { responsibleNis: family.responsibleNis },
    defaults: family
  });
  if (!created) {
    // Just update the family with the new data
    const [, [item]] = await db.families.update(family, { where: { id: createdFamily.id as number }, returning: true });
    return item;
  } else {
    // Family was created
    return createdFamily;
  }
};

/**
 * Create or update family by Responsible NIS
 * @param family Family Object
 */
export const certifyFamilyAndDependents = async (family: Family) => {
  const dbFamily = await certifyFamilyByNis(family);
  dbFamily.dependents = await certifyDependentsByFamilyList(dbFamily.id as number, family.dependents || []);
  return dbFamily;
};

/**
 * Import CSV file to create/update/delete families using the file values
 * @param path CSV file path
 * @param cityId logged user city ID
 * @param deleteOthers delete all non created/updated items on the DB
 */
export const importFamilyFromCSVFile = async (
  path: string,
  cityId: NonNullable<City['id']>,
  deleteOthers?: boolean
): Promise<CSVReport> => {
  const reportResult: CSVReport = { created: 0, updated: 0, deleted: 0, wrong: 0, report: [], finished: false };
  const timeStart = new Date().getTime();
  let promises: Promise<any>[] = [];
  const conversion: Promise<CSVReport> = new Promise((resolve, reject) => {
    csv({ delimiter: ';' })
      .fromFile(path)
      .subscribe(
        (json, lineNumber) => {
          /**
           * Handler for a single line of the CSV file
           */
          const lineHandler = async () => {
            try {
              const timeStartLine = new Date().getTime();
              if (json['cod_parentesco_rf_pessoa'] !== '1') {
                // We're only saving people that are the responsible for the family (RF)
                reportResult.wrong++;
                reportResult.report.push(`[linha: ${lineNumber}] Pessoa ${json['nom_pessoa']} não é um RF`);
                return;
              }
              const group = getFamilyGroupByCode(json.d['fx_rfpc']);
              if (!group) {
                reportResult.wrong++;
                reportResult.report.push(
                  `[linha: ${lineNumber}] Família ${json['cod_familiar_fam']} está com um valor inválido de fx_rfpc`
                );
                return;
              }
              // Converting CSV format to DB format
              const family = {
                code: json.d['cod_familiar_fam'],
                groupName: group.key,
                responsibleName: json['nom_pessoa'],
                responsibleBirthday: moment(json['dta_nasc_pessoa'], 'DD/MM/YYYY').toDate(),
                responsibleNis: json['num_nis_pessoa_atual'],
                responsibleMotherName: json['nom_completo_mae_pessoa'],
                cityId
              };
              // Checking if a family is already created using the same family code and create if don't
              promises.push(certifyFamilyByCode(family));
              reportResult.updated++;

              // Executing promises
              if (promises.length >= 100) {
                await Promise.all(promises);
                promises = [];
              }
              const timeEnd = new Date().getTime();
              process.stdout.write(
                `[line: ${lineNumber}] ------------------------------------ time spent: ${
                  timeEnd - timeStartLine
                }ms - mean: ${((timeEnd - timeStart) / (lineNumber + 1)).toFixed(2)}ms - total: ${
                  timeEnd - timeStart
                }ms         ` + '\r'
              );
            } catch (error) {
              reportResult.wrong++;
              reportResult.report.push(`[linha: ${lineNumber}] Erro inesperado: ${error.message}`);
              logging.error(error);
            }
          };

          return lineHandler();
        },
        (error: Error): void => {
          reject(error);
          logging.error(error);
        },
        async () => {
          if (promises.length > 0) {
            await Promise.all(promises);
          }
          console.log(``);
          console.log(`FINAL TIME: ${new Date().getTime() - timeStart}ms`);
          reportResult.finished = true;
          resolve(reportResult);
        }
      );
  });

  // Delete rows
  if (deleteOthers) {
    // ...
  }

  return conversion;
};

/**
 * Get family dashboard object
 * @param cityId logged user city ID
 */
export const getDashboardInfo = async (cityId: NonNullable<City['id']>) => {
  const dashboard: { [key: string]: number | Date } = { total: 0 };

  const data = await db.families.findAll({
    where: { cityId },
    attributes: ['groupName', [Sequelize.fn('count', Sequelize.fn('distinct', Sequelize.col('id'))), 'count']],
    group: ['groupName']
  });

  for (const item of data) {
    const { count } = item.toJSON() as { count: number };
    dashboard[item.groupName] = Number(count);
    (dashboard.total as number) += Number(count);
  }

  const last = await db.families.max<SequelizeFamily, SequelizeFamily['createdAt']>('createdAt');
  if (last) {
    dashboard.lastCreatedDate = moment(last).toDate();
  }

  return dashboard;
};

/**
 * Function to create a new row on the table
 * @param values object with the new item data
 * @returns Promise<Item>
 */
export const create = (values: Family | SequelizeFamily): Promise<SequelizeFamily> => {
  return db.families.create(values);
};

/**
 * Function to update a row on the table by the unique ID
 * @param id unique ID of the desired item
 * @param values object with the new data
 * @returns Promise<Item>
 */
export const updateById = async (
  id: NonNullable<Family['id']>,
  values: Family | SequelizeFamily
): Promise<SequelizeFamily | null> => {
  // Trying to get item on the city
  const cityItem = await db.families.findByPk(id);
  if (cityItem) {
    // The update return an array [count, item[]], so I'm destructuring to get the updated benefit
    const [, [item]] = await db.families.update(values, { where: { id }, returning: true });
    return item;
  }
  return null;
};

/**
 * Convert CSV family to DB family
 * @param family CSV family
 * @param cityId logged user city unique ID
 * @returns DB family
 */
export const parseFamilyItem = (family: FamilyItem, cityId: NonNullable<City['id']>): Family => {
  return {
    responsibleNis: family['NISTITULAR'],
    responsibleName: family['TITULAR'],
    responsibleBirthday: moment(family['DTNASCTIT'], 'DD/MM/YYYY').toDate(),
    responsibleMotherName: '',
    code: '',
    groupName: getFamilyGroupByCode(0).key,
    cityId
  };
};

/**
 * Check item and throw error if required key is not found
 * @param item single sislame item
 * @param cityId logged user city unique ID
 */
export const checkRequiredSislameData = (item: SislameItem, cityId: NonNullable<City['id']>): void => {
  if (!item) throw { status: 412, message: 'Nenhum dado na tabela do Sislame' };
  const requiredKeys = ['Aluno', 'Mãe', 'Pai', 'Nome Responsável', 'Data Nascimento'] as (keyof OriginalSislameItem)[]; // Checking before removing the special characters
  const availableKeys = Object.keys(item) as (keyof OriginalSislameItem)[];
  const notFoundKeys = requiredKeys.filter((key) => availableKeys.indexOf(key) < 0);
  if (notFoundKeys && notFoundKeys.length > 0) {
    const message = `Na tabela do Sislame, as seguintes colunas não foram encontradas: ${notFoundKeys.join(
      ', '
    )} --- Disponíveis: ${availableKeys.join(', ')}`;
    updateImportReport({ status: 'failed', message, inProgress: false }, cityId);
    throw { status: 412, message };
  }
};

/**
 * Check item and throw error if required key is not found
 * @param item single family item
 * @param cityId logged user city unique ID
 */
export const checkRequiredFamilyData = (item: FamilyItem, cityId: NonNullable<City['id']>): void => {
  if (!item) throw { status: 412, message: 'Nenhum dado na tabela do Bolsa Família' };
  const requiredKeys = [
    'DEPENDENTE',
    'NISDEPENDEN',
    'NISTITULAR',
    'TITULAR',
    'DTNASCTIT',
    'DTNASCDEP'
  ] as (keyof FamilyItem)[]; // Checking before removing the special characters
  const availableKeys = Object.keys(item) as (keyof FamilyItem)[];
  const notFoundKeys = requiredKeys.filter((key) => availableKeys.indexOf(key) < 0);
  if (notFoundKeys && notFoundKeys.length > 0) {
    const message = `Na tabela do Bolsa Família, as seguintes colunas não foram encontradas: ${notFoundKeys.join(
      ', '
    )} --- Disponíveis: ${availableKeys.join(', ')}`;
    updateImportReport({ status: 'failed', message, inProgress: false }, cityId);
    throw { status: 412, message };
  }
};

/**
 * Find the interception between CAD and Sislame data to create the families
 * @param familyFilePath file absolute path
 * @param sislameFilePath file absolute path
 * @param cityId logged user city ID
 */
export const importFamilyFromCadAndSislameCSV = async (
  familyFilePath: string,
  sislameFilePath: string,
  cityId: NonNullable<City['id']>
) => {
  // Get CSV writer to update reson file
  const CSVWriter = getCSVWriter(cityId);
  // Update report status
  updateImportReport({ status: 'reading files' }, cityId);
  // Reading files to get the data
  let originalFamilyData: FamilyItem[] = await csv({ delimiter: ';', flatKeys: true }).fromFile(familyFilePath);
  let originalSislameData: SislameItem[] = await csv({ flatKeys: true }).fromFile(sislameFilePath);

  console.log(`[import] Base bolsa família: ${originalFamilyData.length} items`);
  console.log(`[import] Base sislame:       ${originalSislameData.length} items`);
  console.log(' ');
  console.log('[import] Filtrando dados...');
  console.log(' ');
  // Update report status
  updateImportReport({ status: 'filtering data' }, cityId);

  // Check all important fields
  checkRequiredSislameData(originalSislameData[0], cityId);
  checkRequiredFamilyData(originalFamilyData[0], cityId);

  // Removing duplicated lines in each list
  originalFamilyData = uniqBy(originalFamilyData, (item) => `${item.NISTITULAR}-${item.NISDEPENDEN}`);
  originalSislameData = uniqBy(originalSislameData, (item) => `${item['Aluno']}-${item['Matricula']}`);

  // Filtering data: The reduce will create two arrays, one with the valid data and one with the invalid
  let removedFamilies: FamilyItem[] = [];
  [originalFamilyData, removedFamilies] = originalFamilyData.reduce(
    ([valid, invalid], item) => {
      // Checking the birthday, the dependent can't have more than 17 years

      const validAge = moment().startOf('month').diff(moment(item['DTNASCDEP'], 'DD/MM/YYYY'), 'years') < 18;
      if (!validAge) {
        // Add to invalid data
        return [valid, [...invalid, { ...item, reason: 'Depedente maior de idade' }]];
      }
      // Add to valid data
      return [[...valid, item], invalid];
    },
    [[], []] as FamilyItem[][]
  );
  // Loging invalid data
  await CSVWriter.writeRecords(removedFamilies);

  // Removing special characters
  let familyData: FamilyItem[] = JSON.parse(deburr(JSON.stringify(originalFamilyData)));
  const sislameData: SislameItem[] = JSON.parse(deburr(JSON.stringify(originalSislameData)));

  // Removind duplicated dependent (two parents on the family list)
  // This case is really rare, but can happen
  let duplicatedDependent = familyData.filter((item, index) =>
    familyData.find((duplicated, findIndex) => {
      if (index === findIndex) return false;
      return item.NISDEPENDEN === duplicated.NISDEPENDEN;
    })
  );
  familyData = uniqBy(familyData, (item) => item.NISDEPENDEN);

  console.log(`[import] Base bolsa família: ${familyData.length} items`);
  console.log(`[import] Duplicados: ${duplicatedDependent.length} items`);
  console.log(' ');
  console.log('[import] Comparando duas listas...');
  console.log(' ');

  const grantedFamilies: Family[] = [];

  // Going through each family in the list
  for (const familyIndex in familyData) {
    updateImportReport({ status: 'comparing data', percentage: (Number(familyIndex) + 1) / familyData.length }, cityId);
    process.stdout.write(
      `[import] Famílias comparadas: ${familyIndex}/${familyData.length} (${(
        (100 * Number(familyIndex)) /
        familyData.length
      ).toFixed(2)}%) --- Encontradas: ${grantedFamilies.length}` + '\r'
    );
    const familyItem = familyData[familyIndex];
    // Finding family child on sislame
    const sislameIndex = sislameData.findIndex((sislameItem) => {
      const sameName = compareNames(sislameItem['Aluno'], familyItem['DEPENDENTE']);
      const sameResponsible =
        compareNames(sislameItem['Mae'], familyItem['TITULAR']) ||
        compareNames(sislameItem['Pai'], familyItem['TITULAR']) ||
        compareNames(sislameItem['Nome Responsavel'], familyItem['TITULAR']);
      return sameName && sameResponsible;
    });
    if (sislameIndex > -1) {
      const sislameItem = sislameData[sislameIndex];
      // Check Sislame birthday - seems weird to check just here, but all the reasons need a familyItem
      const validSislameAge =
        moment().startOf('month').diff(moment(sislameItem['Data Nascimento'], 'DD/MM/YYYY'), 'years') < 18;
      if (!validSislameAge) {
        await CSVWriter.writeRecords([{ ...familyItem, reason: 'Dependente não é menor de idade no Sislame' }]);
        continue;
      }
      // Item was found in both databases - check if it's already on the list
      const alreadyOnListIndex = grantedFamilies.findIndex(
        (family) => family.responsibleNis === familyItem['NISTITULAR']
      );
      const dependent = parseFamilyAndSislameItems(originalFamilyData[familyIndex], originalSislameData[sislameIndex]);
      if (alreadyOnListIndex < 0) {
        // Not on the list yet, add it
        grantedFamilies.push({ ...parseFamilyItem(originalFamilyData[familyIndex], cityId), dependents: [dependent] });
      } else {
        // Already on the list, just update the number of children
        const family = grantedFamilies[alreadyOnListIndex];
        grantedFamilies[alreadyOnListIndex] = { ...family, dependents: [...(family.dependents || []), dependent] };
      }
      continue;
    }
    // Item not found in sislame database, trying to find a better reason
    const sislameItem = sislameData.find((sislameItem) => compareNames(sislameItem['Aluno'], familyItem['DEPENDENTE']));
    if (sislameItem) {
      await CSVWriter.writeRecords([
        {
          ...familyItem,
          reason:
            'Encontrado aluno com mesmo nome no Sislame, mas responsável diferente. Atualizar Sislame ou é um homônimo'
        }
      ]);
    } else {
      await CSVWriter.writeRecords([{ ...familyItem, reason: 'Dependente não está no Sislame' }]);
    }
  }

  // Dealing with duplicated families
  while (duplicatedDependent.length > 0) {
    const duplicatedItens = duplicatedDependent.filter(
      (item) => item.NISDEPENDEN === duplicatedDependent[0].NISDEPENDEN
    );
    // For duplicated families, the mother have the priority, then the responsible and finally the father
    type PossibleParents = 'Mae' | 'Pai' | 'Nome Responsavel';
    let foundSislameKey: PossibleParents = 'Mae';
    const sislamePossibleKeys: PossibleParents[] = ['Mae', 'Nome Responsavel', 'Pai'];
    let sislameIndex = -1;
    for (const key of sislamePossibleKeys) {
      sislameIndex = sislameData.findIndex((sislameItem) => {
        const sameName = compareNames(sislameItem['Aluno'], duplicatedItens[0]['DEPENDENTE']);
        const sameParent = duplicatedItens.some((familyItem) => compareNames(sislameItem[key], familyItem['TITULAR']));
        return sameName && sameParent;
      });
      if (sislameIndex > -1) {
        // Found a child in sislame with this parent, save the parent key and exit the loop
        foundSislameKey = key;
        break;
      }
    }
    if (sislameIndex < 0) {
      // Not possible to find a child on Sislame
      await CSVWriter.writeRecords(
        duplicatedItens.map((familyItem) => ({ ...familyItem, reason: 'Dependente não está no Sislame' }))
      );
    } else {
      const sislameItem = sislameData[sislameIndex];
      for (const familyItem of duplicatedItens) {
        // For each item on the list, add it to the list or add reason
        if (compareNames(sislameItem[foundSislameKey], familyItem['TITULAR'])) {
          const sislameItem = sislameData[sislameIndex];
          // Check Sislame birthday - seems weird to check just here, but all the reasons need a familyItem
          const validSislameAge =
            moment().startOf('month').diff(moment(sislameItem['Data Nascimento'], 'DD/MM/YYYY'), 'years') < 18;
          if (!validSislameAge) {
            await CSVWriter.writeRecords([{ ...familyItem, reason: 'Dependente não é menor de idade no Sislame' }]);
            continue;
          }
          const alreadyOnListIndex = grantedFamilies.findIndex(
            (family) => family.responsibleNis === familyItem['NISTITULAR']
          );

          const originalFamilyItem = originalFamilyData.find(
            (item) => item.NISTITULAR === familyItem.NISTITULAR
          ) as FamilyItem; // Getting data without any change
          const dependent = parseFamilyAndSislameItems(originalFamilyItem, originalSislameData[sislameIndex]);
          if (alreadyOnListIndex < 0) {
            // Not on the list yet, add it
            grantedFamilies.push({ ...parseFamilyItem(originalFamilyItem, cityId), dependents: [dependent] });
          } else {
            // Already on the list, just update the number of children
            const family = grantedFamilies[alreadyOnListIndex];
            grantedFamilies[alreadyOnListIndex] = { ...family, dependents: [...(family.dependents || []), dependent] };
          }
        } else {
          await CSVWriter.writeRecords([
            {
              ...familyItem,
              reason: `Dependente está vinculado à outra pessoa (${sislameItem[foundSislameKey]})`
            }
          ]);
        }
      }
    }

    // Removing one group from the array
    duplicatedDependent = duplicatedDependent.filter((item) => item.NISDEPENDEN != duplicatedDependent[0].NISDEPENDEN);
  }

  console.log('');

  // Saving families on the DB
  try {
    const dbFamilies: Family[] = [];
    for (const index in grantedFamilies) {
      process.stdout.write(
        `[import] Famílias salvas: ${index}/${grantedFamilies.length} (${(
          (100 * Number(index)) /
          grantedFamilies.length
        ).toFixed(2)}%)` + '\r'
      );
      updateImportReport({ status: 'saving', percentage: (Number(index) + 1) / grantedFamilies.length }, cityId);
      // Certify family + dependent list
      const family = grantedFamilies[index];
      const dbFamily = await certifyFamilyAndDependents(family);
      dbFamilies.push(dbFamily);
    }
    // Counting dependents
    const dependentCount = dbFamilies.reduce((sum, item) => sum + (item.dependents || []).length, 0);
    console.log('');
    console.log(`[import] Famílias criadas:   ${dbFamilies.length} items`);
    console.log(`[import] Dependentes:        ${dependentCount} items`);

    removeCSVWriter(cityId);
    updateImportReport({ status: 'completed', inProgress: false }, cityId);
  } catch (error) {
    // Something failed, update the report and throw error
    removeCSVWriter(cityId);
    updateImportReport({ status: 'failed', message: error.message, inProgress: false }, cityId);
    throw error;
  }
  console.log('');
  console.log('[import] Finalizado');
};
