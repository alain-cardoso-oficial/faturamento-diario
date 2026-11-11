const { BigQuery } = require('C:/Users/tiofi/Documents/Codex/2026-06-24/pr-2/outputs/business-dashboard-html/node_modules/@google-cloud/bigquery');
const bq = new BigQuery({ keyFilename: 'C:/Users/tiofi/Documents/Codex/2026-06-24/pr-2/outputs/business-dashboard-html/raio-x-394214-4aaec09ba65c.json', projectId: 'raio-x-394214' });
bq.query({ query: "SELECT MAX(Data) AS max_data, COUNTIF(Data = CURRENT_DATE('America/Sao_Paulo')) AS linhas_hoje FROM `raio-x-394214.Dados.Big`", location: 'US' })
  .then(([rows]) => console.log(JSON.stringify(rows)))
  .catch(error => { console.error(error.message); process.exit(1); });
