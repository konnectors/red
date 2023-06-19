import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
const log = Minilog('ContentScript')
Minilog.enable('redCCC')

const DEFAULT_SOURCE_ACCOUNT_IDENTIFIER = 'red'
const BASE_URL = 'https://www.red-by-sfr.fr'
const CLIENT_SPACE_HREF =
  'https://www.red-by-sfr.fr/mon-espace-client/?casforcetheme=espaceclientred#redclicid=X_Menu_EspaceClient'
const PERSONAL_INFOS_URL =
  'https://espace-client-red.sfr.fr/infospersonnelles/contrat/informations'
const INFO_CONSO_URL = 'https://www.sfr.fr/routage/info-conso'
const BILLS_URL_PATH =
  '/facture-mobile/consultation#sfrintid=EC_telecom_mob-abo_mob-factpaiement'
const LOGOUT_HREF =
  'https://www.sfr.fr/auth/realms/sfr/protocol/openid-connect/logout?redirect_uri=https%3A//www.sfr.fr/cas/logout%3Fred%3Dtrue%26url%3Dhttps://www.red-by-sfr.fr'
const CLIENT_SPACE_URL = 'https://espace-client-red.sfr.fr'

class RedContentScript extends ContentScript {
  // ////////
  // PILOT //
  // ////////
  async navigateToLoginForm() {
    this.log('info', 'navigateToLoginForm starts')
    await this.goto(BASE_URL)
    await this.waitForElementInWorker(
      'a[href="https://www.red-by-sfr.fr/mon-espace-client/?casforcetheme=espaceclientred#redclicid=X_Menu_EspaceClient"]'
    )
    await this.runInWorker(
      'click',
      'a[href="https://www.red-by-sfr.fr/mon-espace-client/?casforcetheme=espaceclientred#redclicid=X_Menu_EspaceClient"]'
    )
    await Promise.race([
      this.waitForElementInWorker('#password'),
      this.waitForElementInWorker(
        'a[href="https://www.sfr.fr/cas/logout?red=true&amp;url=https://www.red-by-sfr.fr"]'
      )
    ])
  }

  async ensureNotAuthenticated() {
    this.log('info', 'ensureNotAuthenticated starts')
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('info', 'not auth, returning true')
      return true
    }
    this.log('info', 'auth detected, logging out')
    await this.goto(LOGOUT_HREF)
    // Sometimes the logout lead you to sfr's website, so we cover both possibilities just in case.
    await Promise.race([
      this.waitForElementInWorker(
        'a[href="https://www.red-by-sfr.fr/mon-espace-client/?casforcetheme=espaceclientred#redclicid=X_Menu_EspaceClient"]'
      ),
      this.waitForElementInWorker(
        'a[href="https://www.sfr.fr/mon-espace-client/"]'
      )
    ])
    return true
  }

  async ensureAuthenticated({ account }) {
    this.log('info', 'ensureAuthenticated starts')
    if (!account) {
      await this.ensureNotAuthenticated()
    }
    await this.navigateToLoginForm()

    if (!(await this.runInWorker('checkAuthenticated'))) {
      return await this.authenticate()
    }

    this.log(
      'info',
      'already authenticated still check if authentication is needed on conso page'
    )
    await this.runInWorker('click', `a[href="${INFO_CONSO_URL}"]`)
    await Promise.race([
      this.waitForElementInWorker(`a[href="${BILLS_URL_PATH}"]`),
      this.waitForElementInWorker(`#password`)
    ])

    if (!(await this.runInWorker('checkAuthenticated'))) {
      return await this.authenticate()
    }

    this.log(
      'info',
      'still authenticated but still check if authentication is needed on bills page'
    )

    await this.runInWorker('click', `a[href="${BILLS_URL_PATH}"]`)
    await Promise.race([
      this.waitForElementInWorker(
        'button[onclick="plusFacture(); return false;"]'
      ),
      this.waitForElementInWorker(`#password`)
    ])

    if (!(await this.runInWorker('checkAuthenticated'))) {
      return await this.authenticate()
    }

    return true
  }

  async waitForUserAuthentication() {
    this.log('info', 'waitForUserAuthentication starts')

    const credentials = await this.getCredentials()

    if (credentials) {
      this.log(
        'debug',
        'found credentials, filling fields and waiting for captcha resolution'
      )
      const loginFieldSelector = '#username'
      const passwordFieldSelector = '#password'
      await this.runInWorker('fillText', loginFieldSelector, credentials.login)
      await this.runInWorker(
        'fillText',
        passwordFieldSelector,
        credentials.password
      )
    }

    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    this.log('info', 'getUserDataFromWebsite starts')
    await this.waitForElementInWorker(`a[href="${PERSONAL_INFOS_URL}"]`)
    await this.runInWorker('click', `a[href="${PERSONAL_INFOS_URL}"]`)
    await Promise.race([
      this.waitForElementInWorker('#emailContact'),
      this.waitForElementInWorker('#password')
    ])
    const isLogged = await this.checkAuthenticated()
    if (!isLogged) {
      await this.waitForUserAuthentication()
    }
    await this.waitForElementInWorker('#emailContact')
    this.log('info', 'emailContact Ok, getUserMail starts')
    const sourceAccountId = await this.runInWorker('getUserMail')
    await this.runInWorker('getIdentity')
    if (sourceAccountId === 'UNKNOWN_ERROR') {
      this.log('debug', "Couldn't get a sourceAccountIdentifier, using default")
      return { sourceAccountIdentifier: DEFAULT_SOURCE_ACCOUNT_IDENTIFIER }
    }
    return {
      sourceAccountIdentifier: sourceAccountId
    }
  }

  async fetch(context) {
    this.log('info', 'Fetch starts')
    if (this.store.userCredentials) {
      await this.saveCredentials(this.store.userCredentials)
    }
    await this.waitForElementInWorker(`a[href="${INFO_CONSO_URL}"]`)
    await this.clickAndWait(
      `a[href="${INFO_CONSO_URL}"]`,
      `a[href="${BILLS_URL_PATH}"]`
    )
    await this.clickAndWait(
      `a[href="${BILLS_URL_PATH}"]`,
      'button[onclick="plusFacture(); return false;"]'
    )
    await this.runInWorker('getMoreBills')
    await this.runInWorker('getBills')
    this.log('debug', 'Saving files')
    await this.saveIdentity(this.store.userIdentity)
    for (const bill of this.store.allBills) {
      await this.saveBills([bill], {
        context,
        fileIdAttributes: ['filename'],
        contentType: 'application/pdf',
        qualificationLabel: 'phone_invoice'
      })
    }
  }

  async authenticate() {
    this.log('info', 'authenticate')
    await this.goto(BASE_URL)
    await this.waitForElementInWorker(`a[href="${CLIENT_SPACE_HREF}"]`)
    await this.clickAndWait(`a[href="${CLIENT_SPACE_HREF}"]`, '#password')
    await this.waitForUserAuthentication()
    return true
  }

  // ////////
  // WORKER//
  // ////////

  async checkAuthenticated() {
    const passwordField = document.querySelector('#password')
    const authenticated = !passwordField

    if (authenticated) {
      return authenticated
    }

    const loginField = document.querySelector('#username')
    if (loginField && passwordField) {
      await this.findAndSendCredentials(loginField, passwordField)
    }

    return false
  }

  async findAndSendCredentials(login, password) {
    this.log('debug', 'findAndSendCredentials starts')
    let userLogin = login.value
    let userPassword = password.value
    const userCredentials = {
      login: userLogin,
      password: userPassword
    }
    this.log('debug', 'Sending userCredentials to Pilot')
    this.sendToPilot({
      userCredentials
    })
  }

  async getUserMail() {
    this.log('debug', 'getUserMail starts')
    const userMailElement = document.querySelector('#emailContact').innerHTML
    if (userMailElement) {
      return userMailElement
    }
    return 'UNKNOWN_ERROR'
  }

  async getIdentity() {
    const givenName = document
      .querySelector('#nomTitulaire')
      .innerHTML.split(' ')[0]
    const familyName = document
      .querySelector('#nomTitulaire')
      .innerHTML.split(' ')[1]
    const address = document
      .querySelector('#adresseContact')
      .innerHTML.replace(/\t/g, ' ')
      .replace(/\n/g, '')
    const unspacedAddress = address
      .replace(/(\s{2,})/g, ' ')
      .replace(/^ +/g, '')
      .replace(/ +$/g, '')
    const addressNumbers = unspacedAddress.match(/([0-9]{1,})/g)
    const houseNumber = addressNumbers[0]
    const postCode = addressNumbers[1]
    const addressWords = unspacedAddress.match(/([A-Z ]{1,})/g)
    const street = addressWords[0].replace(/^ +/g, '').replace(/ +$/g, '')
    const city = addressWords[1].replace(/^ +/g, '').replace(/ +$/g, '')
    const mobilePhoneNumber = document.querySelector(
      '#telephoneContactMobile'
    ).innerHTML
    const homePhoneNumber = document.querySelector('#telephoneContactFixe')
    const email = document.querySelector('#emailContact').innerHTML
    const userIdentity = {
      email,
      name: {
        givenName,
        familyName,
        fullname: `${givenName} ${familyName}`
      },
      address: [
        {
          formattedAddress: unspacedAddress,
          houseNumber,
          postCode,
          city,
          street
        }
      ],
      phone: [
        {
          type: 'mobile',
          number: mobilePhoneNumber
        }
      ]
    }
    if (homePhoneNumber !== null) {
      this.log('info', 'homePhoneNumber found, inserting it in userIdentity')
      userIdentity.phone.push({
        type: 'home',
        number: homePhoneNumber.innerHTML
      })
    }
    await this.sendToPilot({ userIdentity })
  }

  async getMoreBills() {
    const moreBillsSelector = 'button[onclick="plusFacture(); return false;"]'
    while (document.querySelector(`${moreBillsSelector}`) !== null) {
      this.log('debug', 'moreBillsButton detected, clicking')
      const moreBillsButton = document.querySelector(`${moreBillsSelector}`)
      moreBillsButton.click()
      // Here, we need to wait for the older bills to load on the page
      await sleep(3)
    }
    this.log('debug', 'No more moreBills button')
  }

  async getBills() {
    this.log('debug', 'getBills starts')
    let allConcatBills = []
    const lastBill = await this.findLastBill()
    allConcatBills.push(lastBill)
    this.log('debug', 'Last bill returned, getting old ones')
    const oldBills = await this.findOldBills()
    const allBills = allConcatBills.concat(oldBills)
    this.log('debug', 'Old bills returned, sending to Pilot')
    await this.sendToPilot({
      allBills
    })
    this.log('debug', 'getBills done')
  }

  async findLastBill() {
    const lastBillElement = document.querySelector(
      'div[class="sr-inline sr-xs-block "]'
    )
    const rawAmount = lastBillElement
      .querySelectorAll('div')[0]
      .querySelector('span').innerHTML
    const fullAmount = rawAmount
      .replace(/&nbsp;/g, '')
      .replace(/ /g, '')
      .replace(/\n/g, '')
    const amount = parseFloat(fullAmount.replace('€', '').replace(',', '.'))
    const currency = fullAmount.replace(/[0-9]*/g, '').replace(',', '')
    const rawDate = lastBillElement
      .querySelectorAll('div')[1]
      .querySelectorAll('span')[1].innerHTML
    const dateArray = rawDate.split('/')
    const day = dateArray[0]
    const month = dateArray[1]
    const year = dateArray[2]
    const rawPaymentDate = lastBillElement
      .querySelectorAll('div')[1]
      .querySelectorAll('span')[0].innerHTML
    const paymentArray = rawPaymentDate.split('/')
    const paymentDay = paymentArray[0]
    const paymentMonth = paymentArray[1]
    const paymentYear = paymentArray[2]
    const filepath = lastBillElement
      .querySelectorAll('div')[3]
      .querySelector('a')
      .getAttribute('href')
    const fileurl = `${CLIENT_SPACE_URL}${filepath}`
    const lastBill = {
      amount,
      currency: currency === '€' ? 'EUR' : currency,
      date: new Date(`${month}/${day}/${year}`),
      paymentDate: new Date(`${paymentMonth}/${paymentDay}/${paymentYear}`),
      filename: await getFileName(dateArray, amount, currency),
      vendor: 'red',
      fileurl,
      fileAttributes: {
        metadata: {
          contentAuthor: 'red',
          datetime: new Date(`${month}/${day}/${year}`),
          datetimeLabel: 'issueDate',
          isSubscription: true,
          issueDate: new Date(`${month}/${day}/${year}`),
          carbonCopy: true
        }
      }
    }

    if (lastBillElement.children[2].querySelectorAll('a').length > 1) {
      const detailedFilepath = lastBillElement.children[2]
        .querySelectorAll('a')[1]
        .getAttribute('href')
      const detailed = detailedFilepath.match('detail') ? true : false
      lastBill.filename = await getFileName(
        dateArray,
        amount,
        currency,
        detailed
      )
    }
    return lastBill
  }

  async findOldBills() {
    let oldBills = []
    const allBillsElements = document
      .querySelector('#blocAjax')
      .querySelectorAll('.sr-container-content-line')
    let counter = 0
    for (const oneBill of allBillsElements) {
      this.log(
        'debug',
        `fetching bill ${counter++}/${allBillsElements.length}...`
      )
      const rawAmount = oneBill.children[0].querySelector('span').innerHTML
      const fullAmount = rawAmount
        .replace(/&nbsp;/g, '')
        .replace(/ /g, '')
        .replace(/\n/g, '')
      const amount = parseFloat(fullAmount.replace('€', '').replace(',', '.'))
      const currency = fullAmount.replace(/[0-9]*/g, '').replace(',', '')
      const rawDate = oneBill.children[1].querySelector('span').innerHTML
      const dateArray = rawDate.split(' ')
      const day = dateArray[0]
      const month = computeMonth(dateArray[1])
      if (month === null) {
        this.log(
          'warn',
          `Could not parse month in ${dateArray[1]}. This bill will be ignored`
        )
        continue
      }
      const year = dateArray[2]
      const rawPaymentDate = oneBill.children[1].innerHTML
        .replace(/\n/g, '')
        .replace(/ /g, '')
        .match(/([0-9]{2}[a-zûé]{3,4}.?-)/g)
      const filepath = oneBill.children[4]
        .querySelector('a')
        .getAttribute('href')
      const fileurl = `${CLIENT_SPACE_URL}${filepath}`

      let computedBill = {
        amount,
        currency: currency === '€' ? 'EUR' : currency,
        date: new Date(`${month}/${day}/${year}`),
        filename: await getFileName(dateArray, amount, currency),
        fileurl,
        vendor: 'red',
        fileAttributes: {
          metadata: {
            contentAuthor: 'red',
            datetime: new Date(`${month}/${day}/${year}`),
            datetimeLabel: 'issueDate',
            isSubscription: true,
            issueDate: new Date(`${month}/${day}/${year}`),
            carbonCopy: true
          }
        }
      }
      // After the first year of bills, paymentDate is not given anymore
      // So we need to check if the bill has a defined paymentDate
      if (rawPaymentDate !== null) {
        const paymentDay = rawPaymentDate[0].match(/[0-9]{2}/g)
        const rawPaymentMonth = rawPaymentDate[0].match(/[a-zûé]{3,4}\.?/g)
        const paymentMonth = computeMonth(rawPaymentMonth[0])
        // Assigning the same year founded for the bill's creation date
        // as it is not provided, assuming the bill has been paid on the same year
        const paymentYear = year

        computedBill.paymentDate = new Date(
          `${paymentMonth}/${paymentDay}/${paymentYear}`
        )
      }
      if (oneBill.children[4].querySelectorAll('a')[1] !== undefined) {
        const detailedFilepath = oneBill.children[4]
          .querySelectorAll('a')[1]
          .getAttribute('href')
        const detailed = detailedFilepath.match('detail') ? true : false
        const detailedBill = {
          ...computedBill
        }
        const fileurl = `${CLIENT_SPACE_URL}${detailedFilepath}`
        detailedBill.filename = await getFileName(
          dateArray,
          amount,
          currency,
          detailed,
          fileurl
        )
        oldBills.push(detailedBill)
      }
      oldBills.push(computedBill)
    }
    this.log('debug', 'Old bills fetched')
    return oldBills
  }
}

const connector = new RedContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'getUserMail',
      'getMoreBills',
      'getBills',
      'getIdentity'
    ]
  })
  .catch(err => {
    log.warn(err)
  })

function sleep(delay) {
  return new Promise(resolve => {
    setTimeout(resolve, delay * 1000)
  })
}

async function getFileName(dateArray, amount, currency, detailed) {
  return `${dateArray[2]}-${computeMonth(dateArray[1])}-${
    dateArray[0]
  }_red_${amount}${currency}${detailed ? '_détail' : ''}.pdf`
}

function computeMonth(month) {
  let computedMonth = null
  switch (month) {
    case 'janv.':
    case 'Jan':
    case '01':
      computedMonth = '01'
      break
    case 'févr.':
    case 'Feb':
    case '02':
      computedMonth = '02'
      break
    case 'mars':
    case 'Mar':
    case '03':
      computedMonth = '03'
      break
    case 'avr.':
    case 'Apr':
    case '04':
      computedMonth = '04'
      break
    case 'mai':
    case 'May':
    case '05':
      computedMonth = '05'
      break
    case 'juin':
    case 'Jun':
    case '06':
      computedMonth = '06'
      break
    case 'juil.':
    case 'Jul':
    case '07':
      computedMonth = '07'
      break
    case 'août':
    case 'Aug':
    case '08':
      computedMonth = '08'
      break
    case 'sept.':
    case 'Sep':
    case '09':
      computedMonth = '09'
      break
    case 'oct.':
    case 'Oct':
    case '10':
      computedMonth = '10'
      break
    case 'nov.':
    case 'Nov':
    case '11':
      computedMonth = '11'
      break
    case 'déc.':
    case 'Dec':
    case '12':
      computedMonth = '12'
      break
  }
  return computedMonth
}
