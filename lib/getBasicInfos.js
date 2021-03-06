const cheerio = require('cheerio');
const request = require('request-promise-native');
const buildPromise = require('./buildPromise');
const unmasker = require('./unmaskNumbers');
const getBodyAndEncode = require('./getBodyAndEncode');
const cnpjValidator = require('./validateCnpj');
const validateRequest = require('./validateRequest');
const makeJar = require('./makeJar');

const validateCnpj = c =>
  ((!cnpjValidator(c))
      ? buildPromise(new Error('O CNPJ informado não é válido!'))
      : buildPromise(unmasker(c)));

const getData = (cnpj, sessionId, solvedCaptcha) =>
  request({
    encoding: null,
    url: 'http://www.receita.fazenda.gov.br/PessoaJuridica/CNPJ/cnpjreva/valida.asp',
    jar: makeJar('http://www.receita.fazenda.gov.br/PessoaJuridica/CNPJ/cnpjreva/valida.asp', sessionId),
    method: 'POST',
    followAllRedirects: true,
    resolveWithFullResponse: true,
    form: {
      origem: 'comprovante',
      cnpj,
      txtTexto_captcha_serpro_gov_br: solvedCaptcha,
      submit1: 'Consultar',
      search_type: 'cnpj',
    },
    headers: {
      Host: 'www.receita.fazenda.gov.br',
      Connection: 'keep-alive',
      Pragma: 'no-cache',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': 111,
      'Cache-Control': 'max-age=0',
      'Upgrade-Insecure-Requests': 1,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      Referer: 'http://www.receita.fazenda.gov.br/pessoajuridica/cnpj/cnpjreva/cnpjreva_solicitacao2.asp',
      'Accept-Encoding': 'gzip, deflate, sdch',
      'Accept-Language': 'pt-BR,pt;q=0.8,en-US;q=0.6,en;q=0.4',
    },
  });

const checkBodyForErrors = (body) => {
  const $ = cheerio.load(body);

  let manipulatedString;

  manipulatedString = $('p').next().text().split('\r\n\t')[0];
  if (manipulatedString.startsWith('Esta página tem como objetivo permitir a emissão do Comprovante de Inscrição e de Situação Cadastral')) {
    return buildPromise(new Error('O captcha informado é inválido!'));
  }

  manipulatedString = $('title').text();
  if (manipulatedString === 'Validação ASP') {
    return buildPromise(new Error('Erro durante a validação dos dados informados!'));
  }

  manipulatedString = $('table').next().next().text()
    .trim();
  if (manipulatedString.startsWith('O número do CNPJ não é válido.')) {
    return buildPromise(new Error('O CNPJ informado não é válido!'));
  }
  if (manipulatedString.startsWith('Não existe no Cadastro de Pessoas Jurídicas o número de CNPJ informado.')) {
    return buildPromise(new Error('O CNPJ informado não consta na base de dados da Receita Federal do Brasil!'));
  }

  return buildPromise(body);
};

const processDate = s =>
  new Date(s.split('/')[2], s.split('/')[1] - 1, s.split('/')[0]);

const processCodeAndDescriptions = s =>
  ({
    CÓDIGO: unmasker((s.split(' - '))[0]),
    DESCRIÇÃO: (s.split(' - '))[1].trim(),
  });

const dataParser = () =>
  ({
    'NÚMERO DE INSCRIÇÃO': unmasker,
    'DATA DE ABERTURA': processDate,
    'CÓDIGO E DESCRIÇÃO DA ATIVIDADE ECONÔMICA PRINCIPAL': processCodeAndDescriptions,
    'CÓDIGO E DESCRIÇÃO DAS ATIVIDADES ECONÔMICAS SECUNDÁRIAS': (s, e) => {
      const result = [];

      e.each((i, elem) => {
        const processedElement = cheerio.load(elem).text().trim();

        if (processedElement !== '' && i !== 0) {
          result.push(processCodeAndDescriptions(processedElement));
        }
      });

      return result;
    },
    'CÓDIGO E DESCRIÇÃO DA NATUREZA JURÍDICA': processCodeAndDescriptions,
    CEP: unmasker,
    TELEFONE: unmasker,
    'DATA DA SITUAÇÃO CADASTRAL': processDate,
    'DATA DA SITUAÇÃO ESPECIAL': processDate,
  });

const dataKeys = () =>
  ([
    'NÚMERO DE INSCRIÇÃO',
    'DATA DE ABERTURA',
    'NOME EMPRESARIAL',
    'TÍTULO DO ESTABELECIMENTO (NOME DE FANTASIA)',
    'CÓDIGO E DESCRIÇÃO DA ATIVIDADE ECONÔMICA PRINCIPAL',
    'CÓDIGO E DESCRIÇÃO DAS ATIVIDADES ECONÔMICAS SECUNDÁRIAS',
    'CÓDIGO E DESCRIÇÃO DA NATUREZA JURÍDICA',
    'LOGRADOURO',
    'NÚMERO',
    'COMPLEMENTO',
    'CEP',
    'BAIRRO/DISTRITO',
    'MUNICÍPIO',
    'UF',
    'ENDEREÇO ELETRÔNICO',
    'TELEFONE',
    'ENTE FEDERATIVO RESPONSÁVEL (EFR)',
    'SITUAÇÃO CADASTRAL',
    'DATA DA SITUAÇÃO CADASTRAL',
    'MOTIVO DE SITUAÇÃO CADASTRAL',
    'SITUAÇÃO ESPECIAL',
    'DATA DA SITUAÇÃO ESPECIAL',
  ]);

const parseExtractedDataFromBody = (body) => {
  const asteriskRegex = /^([*]{1,})$/;
  const $ = cheerio.load(body);
  const base = $('body > div > table  > tr > td > table > tr > td ');
  const keys = dataKeys();
  const result = {};

  base.each((i, elem) => {
    const k = $(elem).children().eq(0).text().trim();
    const element = $(elem).children();
    const processedElement = $(elem).children().eq(2).text().trim();

    if (keys.includes(k)
      && processedElement
      && !asteriskRegex.test(processedElement)
      && !processedElement.includes('Não informada')) {
      result[k] = (dataParser()[k] ? dataParser()[k](processedElement, element) : processedElement);
    }
  });

  return buildPromise(result);
};

const getBasicInfos = (cnpj, sessionId, solvedCaptcha) =>
  ((!cnpj || !sessionId || !solvedCaptcha)
    ? buildPromise(new Error('Valores informados são inválidos!'))
    : validateCnpj(cnpj)
      .then(validCnpj => getData(validCnpj, sessionId, solvedCaptcha))
      .then(response => validateRequest(response, 'Impossível recuperar as informações do CNPJ informado!'))
      .then(getBodyAndEncode)
      .then(checkBodyForErrors)
      .then(parseExtractedDataFromBody));

module.exports = getBasicInfos;
