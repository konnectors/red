import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import waitFor, { TimeoutError } from 'p-wait-for'
import pRetry from 'p-retry'
const log = Minilog('ContentScript')
Minilog.enable('redCCC')

const BASE_URL = 'https://www.red-by-sfr.fr'
const CLIENT_SPACE_HREF =
  'https://www.red-by-sfr.fr/mon-espace-client/?casforcetheme=espaceclientred#redclicid=X_Menu_EspaceClient'
const INFO_CONSO_URL = 'https://espace-client-red.sfr.fr/infoconso-mobile/conso'
const MOBILE_BILLS_URL_PATH =
  '/facture-mobile/consultation#sfrintid=EC_telecom_mob-abo_mob-factpaiement'
const FIXE_CONSO_URL = 'https://espace-client-red.sfr.fr/facture-fixe/infoconso'
const CLIENT_SPACE_URL = 'https://espace-client-red.sfr.fr'

class RedContentScript extends ContentScript {
  async onWorkerReady() {
    await this.waitForElementNoReload('#loginForm')
    this.watchLoginForm.bind(this)()
  }

  onWorkerEvent({ event, payload }) {
    if (event === 'loginSubmit') {
      this.log('info', `User's credential intercepted`)
      const { login, password } = payload
      this.store.userCredentials = { login, password }
    }
  }

  watchLoginForm() {
    this.log('info', '📍️ watchLoginForm starts')
    const loginField = document.querySelector('#username')
    const passwordField = document.querySelector('#password')
    if (loginField && passwordField) {
      this.log('info', 'Found credentials fields, adding form listener')
      const loginForm = document.querySelector('#loginForm')
      loginForm.addEventListener('submit', () => {
        const login = loginField.value
        const password = passwordField.value
        const event = 'loginSubmit'
        const payload = { login, password }
        this.bridge.emit('workerEvent', {
          event,
          payload
        })
      })
    }
  }

  async ensureAuthenticated() {
    this.log('info', '🤖 ensureAuthenticated starts')
    await pRetry(
      async () => {
        try {
          await this.ensureNotAuthenticated.bind(this)()
        } catch (err) {
          if (err instanceof Error) {
            throw err
          } else {
            this.log(
              'warn',
              `caught an Error which is not instance of Error: ${
                err?.message || JSON.stringify(err)
              }`
            )
            throw new Error(err?.message || err)
          }
        }
      },
      {
        retries: 3,
        onFailedAttempt: error => {
          this.log(
            'info',
            `Logout attempt ${error.attemptNumber} failed. There are ${error.retriesLeft} retries left.`
          )
        }
      }
    )
    await this.waitForUserAuthentication()

    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated starts')
    await this.goto(BASE_URL)
    const logoutLinkSelector = 'a[href*="sfr.fr/cas/logout"]'
    await this.waitForElementInWorker(logoutLinkSelector)
    await this.runInWorker('click', logoutLinkSelector)
    await sleep(1)
    await this.waitForElementInWorker(logoutLinkSelector)
    await this.goto(CLIENT_SPACE_URL)
    await this.waitForElementInWorker('#username')

    return true
  }

  async navigateToLoginForm() {
    this.log('info', '🤖 navigateToLoginForm starts')
    await this.goto(BASE_URL)
    await sleep(1) // let some time to start the load of the next page
    await this.waitForElementInWorker(
      'a[href="https://www.red-by-sfr.fr/mon-espace-client/"]'
    )
    await this.goto('https://www.red-by-sfr.fr/mon-espace-client/')
    await sleep(1) // let some time to start the load of the next page
    await Promise.race([
      this.waitForElementInWorker('#password'),
      this.waitForElementInWorker('a', { includesText: 'Me déconnecter' }),
      this.runInWorkerUntilTrue({ method: 'waitForSfrUrl' })
    ])
  }

  isSfrUrl() {
    const currentUrl = window.location.href
    const isSfrLoginForm = currentUrl.includes(
      'service=https%3A%2F%2Fwww.sfr.fr'
    )
    const isSfrEspaceClient = currentUrl.includes(
      'www.sfr.fr/mon-espace-client'
    )
    const result = isSfrLoginForm || isSfrEspaceClient
    return result
  }

  async waitForUserAuthentication() {
    this.log('info', '🤖 waitForUserAuthentication starts')

    const credentials = await this.getCredentials()
    await this.checkAndHideRememberMe()
    // to ensure credentials are already written before user sees the page
    if (credentials) await this.runAutoFill(credentials)
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'checkAuthenticated',
      args: [credentials]
    })
    await this.setWorkerState({ visible: false })
  }

  async runAutoFill(credentials) {
    this.log('info', '📍️ runAutoFill starts')
    if (credentials) {
      const loginFieldSelector = '#username'
      const passwordFieldSelector = '#password'
      await this.runInWorker('fillText', loginFieldSelector, credentials.login)
      await this.runInWorker(
        'fillText',
        passwordFieldSelector,
        credentials.password
      )
      return
    }
    this.log('warn', 'No credentials to use in autoFill')
    return
  }

  async checkAndHideRememberMe() {
    this.log('info', '📍️ checkAndHideRememberMe starts')
    if (!(await this.isElementInWorker('#remember-me'))) {
      this.log(
        'warn',
        'Cannot find the rememberMe checkbox, logout might not work as expected'
      )
    } else {
      await this.evaluateInWorker(function uncheckAndHideRememberMe() {
        const checkBox = document.querySelector('#remember-me')
        checkBox.click()
        // Setting the visibility to hidden on the parent to make the element disapear
        // preventing users to click it
        checkBox.parentNode.style.visibility = 'hidden'
      })
    }
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite starts')
    await this.waitForElementInWorker(
      `a[href*="//www.sfr.fr/mon-espace-client/redirect.html?e="]`
    )
    const redMLS = await this.runInWorker('checkPersonnalInfosLinkAvailability')
    if (!redMLS) {
      this.log(
        'warn',
        'Access to personnal infos page is not allowed for this contract, skipping identity scraping'
      )
      const credentials = await this.getCredentials()
      const storeLogin = this.store.userCredentials?.login
      return {
        sourceAccountIdentifier: credentials?.login || storeLogin
      }
    } else {
      this.store.redLMS = redMLS
      const sourceAccountId = await this.findUserSAI(redMLS)
      // Fetching identity immediatly if possible as we are on the identity page
      this.store.userIdentity = await this.runInWorker('getIdentity')
      if (sourceAccountId === 'UNKNOWN_ERROR') {
        this.log(
          'debug',
          "Couldn't get a sourceAccountIdentifier, using default"
        )
        throw new Error('Could not get a sourceAccountIdentifier')
      }
      return {
        sourceAccountIdentifier: sourceAccountId
      }
    }
  }

  async findUserSAI(redMLS) {
    this.log('info', '📍️ findUserSAI starts')
    await this.runInWorker(
      'click',
      `a[href="//www.sfr.fr/mon-espace-client/redirect.html?e=${redMLS}&U=https%3A//espace-client-red.sfr.fr/infospersonnelles/contrat/informations/%3Fred%3D1"]`
    )
    await this.checkIfRelogingIsNeeded('#emailContact')
    await this.waitForElementInWorker('#emailContact')
    this.log('info', 'emailContact Ok, getUserMail starts')
    return await this.runInWorker('getUserMail')
  }

  async checkIfRelogingIsNeeded(awaitedElement) {
    this.log('info', '📍️ checkIfRelogingIsNeeded starts')
    // await this.waitForElementInWorker('#emailContact, #password')
    await this.waitForElementInWorker(`${awaitedElement}, #password`)
    const isLogged = await this.checkAuthenticated()
    if (!isLogged) {
      await this.waitForUserAuthentication()
    }
  }

  async fetch(context) {
    this.log('info', '🤖 Fetch starts')
    if (this.store.userCredentials) {
      await this.saveCredentials(this.store.userCredentials)
    }
    await Promise.all([
      this.waitForElementInWorker(
        `a[href='https://espace-client-red.sfr.fr/gestion-ligne/lignes/ajouter']`
      ),
      this.waitForElementInWorker(`a[href="${INFO_CONSO_URL}"]`)
    ])
    const contracts = await this.runInWorker('getContracts')
    if (
      contracts[0].text.startsWith('06') ||
      contracts[0].text.startsWith('07')
    ) {
      await this.goto(`${CLIENT_SPACE_URL}${MOBILE_BILLS_URL_PATH}`)
    } else {
      await this.goto(FIXE_CONSO_URL)
    }
    await this.waitForElementInWorker('#blocAjax, #historique, #password')
    // Sometimes when reaching the bills page, website ask for a re-authentication.
    // As we cannot do an autoLogin or autoFill, we just show the page to the user so he can make the login confirmation
    const askRelogin = await this.isElementInWorker('#password')
    if (askRelogin) {
      await this.waitForUserAuthentication()
    }
    let counter = 0
    let isFirstContract = true
    for (const contract of contracts) {
      counter++
      this.log('info', `Fetching contract : ${counter}/${contracts.length}`)
      if (!isFirstContract) {
        await this.navigateToNextContract(contract)
      }
      const altButton = await this.isElementInWorker('#plusFac')
      const normalButton = await this.isElementInWorker(
        'button[onclick="plusFacture(); return false;"]'
      )
      if (altButton || normalButton) {
        await this.runInWorker('getMoreBills')
      }
      await this.runInWorker('getBills')
      this.log('debug', 'Saving files')
      if (this.store.userIdentity) {
        await this.saveIdentity({ contact: this.store.userIdentity })
      }
      const detailedBills = []
      const normalBills = []
      for (const bill of this.store.allBills) {
        if (bill.filename.includes('détail')) {
          detailedBills.push(bill)
        } else {
          normalBills.push(bill)
        }
      }
      await this.saveBills(normalBills, {
        context,
        fileIdAttributes: ['filename'],
        contentType: 'application/pdf',
        subPath: `${contract.text}`,
        qualificationLabel: 'phone_invoice'
      })
      // Conditioning this saveBills so it don't create
      // an empty folder if there is nothing to download
      if (detailedBills.length) {
        await this.saveBills(detailedBills, {
          context,
          fileIdAttributes: ['filename'],
          contentType: 'application/pdf',
          subPath: `${contract.text}/Detailed invoices`,
          qualificationLabel: 'phone_invoice'
        })
      }
      isFirstContract = false
    }
  }

  async navigateToNextContract(contract) {
    this.log('info', `📍️ navigateToNextContract starts for ${contract.text}`)
    // Removing elements here is to ensure we're not finding the awaited elements
    // before the next contract is loaded
    if (await this.isElementInWorker('#plusFac')) {
      await this.evaluateInWorker(function removeElement() {
        document.querySelector('#lastFacture').remove()
      })
    } else {
      await this.evaluateInWorker(function removeElement() {
        document.querySelector('div[class="sr-inline sr-xs-block "]').remove()
      })
    }
    await this.runInWorker('click', `li[id='${contract.id}']`)
    await this.waitForElementInWorker(
      'div[class="sr-inline sr-xs-block"], div[class="sr-inline sr-xs-block "], #lastFacture'
    )
  }
  // ////////
  // WORKER//
  // ////////

  async waitForSfrUrl() {
    this.log('info', '📍️ waitForSfrUrl starts')
    await waitFor(this.isSfrUrl, {
      interval: 100,
      timeout: {
        milliseconds: 10000,
        message: new TimeoutError('waitForSfrUrl timed out after 10sec')
      }
    })
    return true
  }

  async checkAuthenticated(credentials) {
    await waitFor(
      async () => {
        const isLoginUrl = /www.sfr.fr\/cas\/login/.test(window.location.href)
        if (!isLoginUrl) {
          return true
        }
        const passwordField = document.querySelector('#password')
        const loginField = document.querySelector('#username')
        // Website is sometimes redirecting the form submit request to an empty loginForm for no obvious reasons
        // this is made to ensure credentials are always filled in when available, even on page reloads
        if (
          (credentials && !passwordField.value) ||
          (credentials && !loginField.value)
        ) {
          this.log(
            'info',
            'loginForm has been emptied after submit, filling it again'
          )
          await this.fillText('#password', credentials.password)
          await this.fillText('#username', credentials.login)
        }

        return false
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    return true
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
    this.log('info', '📍️ getIdentity starts')
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
    const mobilePhoneNumber = document
      .querySelector('#telephoneContactMobile')
      .innerHTML.trim()
    const homePhoneNumber = document.querySelector('#telephoneContactFixe')
    const email = document.querySelector('#emailContact').innerHTML
    const userIdentity = {
      email: [{ address: email }],
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
        number: homePhoneNumber.innerHTML.trim()
      })
    }
    return userIdentity
  }

  async getContracts() {
    this.log('info', '📍️ getContracts starts')
    const contracts = []
    const actualContractText = document
      .querySelector(
        `a[href='https://espace-client-red.sfr.fr/gestion-ligne/lignes/ajouter']`
      )
      .parentNode.parentNode.previousSibling.innerHTML.trim()
    let actualContractType
    if (
      actualContractText.startsWith('06') ||
      actualContractText.startsWith('07')
    ) {
      actualContractType = 'mobile'
    } else {
      actualContractType = 'fixe'
    }
    const actualContract = {
      text: actualContractText,
      id: 'current',
      type: actualContractType
    }
    contracts.push(actualContract)
    contracts.push(
      ...Array.from(
        document
          .querySelector(
            `a[href='https://espace-client-red.sfr.fr/gestion-ligne/lignes/ajouter']`
          )
          .parentNode.parentNode.querySelectorAll('li')
      )
        .filter(el => !el.getAttribute('class'))
        .map(el => {
          const text = el.innerHTML.trim()
          let type
          if (text.startsWith('06') || text.startsWith('07')) {
            type = 'mobile'
          } else {
            type = 'fixe'
          }
          return {
            id: el.getAttribute('id') || 'current',
            text,
            type
          }
        })
    )
    return contracts
  }

  async getMoreBills() {
    const moreBillsSelector = 'button[onclick="plusFacture(); return false;"]'
    const moreBillAltWrapperSelector = '#plusFacWrap'
    const moreBillAltSelector = '#plusFac'
    if (document.querySelector(moreBillsSelector)) {
      while (document.querySelector(`${moreBillsSelector}`) !== null) {
        this.log('debug', 'moreBillsButton detected, clicking')
        const moreBillsButton = document.querySelector(`${moreBillsSelector}`)
        moreBillsButton.click()
        // Here, we need to wait for the older bills to load on the page
        await sleep(3)
      }
    }
    if (
      document.querySelector(moreBillAltSelector) &&
      document.querySelector(moreBillAltWrapperSelector)
    ) {
      while (
        !document
          .querySelector(`${moreBillAltWrapperSelector}`)
          .getAttribute('style')
      ) {
        this.log('debug', 'moreBillsButton detected, clicking')
        const moreBillsButton = document.querySelector(`${moreBillAltSelector}`)
        moreBillsButton.click()
        // Here, we need to wait for the older bills to load on the page
        await sleep(3)
      }
    }
    this.log('debug', 'No more moreBills button')
  }

  async getBills(contractName) {
    this.log('info', '📍️ getBills starts')
    let lastBill
    let allBills
    // Selector of the alternative lastBill element
    if (document.querySelector('#lastFacture')) {
      lastBill = await this.findAltLastBill(contractName)
      this.log('debug', 'Last bill returned, getting old ones')
      const oldBills = await this.findAltOldBills(contractName)
      allBills = lastBill.concat(oldBills)
      this.log('debug', 'Old bills returned, sending to Pilot')
    } else {
      lastBill = await this.findLastBill(contractName)
      this.log('debug', 'Last bill returned, getting old ones')
      const oldBills = await this.findOldBills(contractName)
      allBills = lastBill.concat(oldBills)
      this.log('debug', 'Old bills returned, sending to Pilot')
    }

    await this.sendToPilot({
      allBills
    })
    this.log('debug', 'getBills done')
  }

  async findLastBill() {
    this.log('info', '📍️ findLastBill starts')
    const lastBill = []
    const alertBox = document
      .querySelector('.sr-sc-message-alert')
      ?.innerText?.trim()
    if (alertBox) {
      this.log('error', 'Found alert box on bills page : ' + alertBox)
      throw new Error('VENDOR_DOWN')
    }
    const lastBillElement = document.querySelector(
      'div[class="sr-inline sr-xs-block "]'
    )
    if (lastBillElement.innerHTML.includes('à partir du')) {
      this.log(
        'info',
        'This bill has no dates to fetch yet, fetching it when dates has been given'
      )
      return []
    }
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
      ?.querySelectorAll('div')?.[1]
      ?.querySelectorAll('span')?.[1]?.innerHTML

    if (!rawDate) {
      this.log(
        'warn',
        'Could not find last bill, this may be because it is not payed yet'
      )
      return null
    }
    const dateArray = rawDate.split('/')
    const day = dateArray[0]
    const month = dateArray[1]
    const year = dateArray[2]
    const rawPaymentDate = lastBillElement
      .querySelectorAll('div')?.[1]
      ?.querySelectorAll('span')?.[0]?.innerHTML
    const filepath = lastBillElement
      .querySelector('#lien-telecharger-pdf')
      .getAttribute('href')
    const fileurl = `${CLIENT_SPACE_URL}${filepath}`
    const normalBill = {
      amount,
      currency: currency === '€' ? 'EUR' : currency,
      date: new Date(`${month}/${day}/${year}`),
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
    // After the first year of bills, paymentDate is not given anymore
    // So we need to check if the bill has a defined paymentDate
    if (rawPaymentDate !== null) {
      const paymentDay = rawPaymentDate.match(/[0-9]{2}/g)[0]
      const rawPaymentMonth = rawPaymentDate.match(/[a-zûé]{3,4}\.?/g)
      const paymentMonth = computeMonth(rawPaymentMonth[0])
      // Assigning the same year founded for the bill's creation date
      // as it is not provided, assuming the bill has been paid on the same year
      const paymentYear = year
      normalBill.paymentDate = new Date(
        `${paymentMonth}/${paymentDay}/${paymentYear}`
      )
    }
    lastBill.push(normalBill)
    if (
      lastBillElement.querySelectorAll('[id*="lien-telecharger-"]').length > 1
    ) {
      const detailedFilepath = lastBillElement
        .querySelector('[id*="lien-telecharger-fadet"]')
        .getAttribute('href')
      const detailed = detailedFilepath.match('detail') ? true : false
      lastBill.filename = await getFileName(
        dateArray,
        amount,
        currency,
        detailed
      )
      const detailedBill = {
        ...normalBill
      }
      detailedBill.fileurl = `${CLIENT_SPACE_URL}${detailedFilepath}`
      lastBill.push(detailedBill)
    }
    return lastBill
  }

  async findAltLastBill(contractName) {
    this.log('info', '📍️ findAltLastBill starts')
    let lastBill = []
    const lastBillElement = document.querySelector(
      'div[class="sr-inline sr-xs-block"]'
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
    const dateElementTextContent = lastBillElement
      .querySelectorAll('div')[1]
      .textContent.trim()
    const foundDates = dateElementTextContent
      .replace(/ {2,}/g, '')
      .replace(/\n/g, ' ')
      .match(/(\d{2})\/(\d{2})\/(\d{4})/g)
    let issueDate
    let paymentDate
    if (foundDates.length === 2) {
      paymentDate = foundDates[0]
      issueDate = foundDates[1]
    } else {
      paymentDate = null
      issueDate = foundDates[0]
    }
    const [issueDay, issueMonth, issueYear] = issueDate.split('/')
    const filepath = lastBillElement.querySelector('a').getAttribute('href')
    const fileurl = `${CLIENT_SPACE_URL}${filepath}`
    const filename = await getFileName(
      [issueDay, issueMonth, issueYear],
      amount,
      currency
    )
    this.log('info', `filename : ${filename}`)
    const computedLastBill = {
      amount,
      currency: currency === '€' ? 'EUR' : currency,
      date: new Date(`${issueMonth}/${issueDay}/${issueYear}`),
      filename,
      fileurl,
      vendor: 'sfr',
      subPath: contractName,
      fileAttributes: {
        metadata: {
          contentAuthor: 'sfr',
          datetime: new Date(`${issueMonth}/${issueDay}/${issueYear}`),
          datetimeLabel: 'issueDate',
          isSubscription: true,
          issueDate: new Date(),
          carbonCopy: true
        }
      }
    }
    if (paymentDate !== null) {
      const paymentArray = paymentDate.split('/')
      const paymentDay = paymentArray[0]
      const paymentMonth = paymentArray[1]
      const paymentYear = paymentArray[2]
      computedLastBill.paymentDate = new Date(
        `${paymentMonth}/${paymentDay}/${paymentYear}`
      )
    }

    lastBill.push(computedLastBill)
    return lastBill
  }

  async findOldBills() {
    this.log('info', '📍️ findOldBills starts')
    let oldBills = []
    const allBillsElements = document
      .querySelector('#blocAjax')
      .querySelectorAll('.sr-container-content-line')
    let counter = 1
    for (const oneBill of allBillsElements) {
      this.log(
        'debug',
        `fetching bill ${counter}/${allBillsElements.length}...`
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
      const filepath = oneBill
        .querySelector('[id*="lien-duplicata-pdf-"]')
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
      if (oneBill.querySelectorAll('[id*="lien-"]').length > 1) {
        const detailedFilepath = oneBill
          .querySelector('[id*="lien-telecharger-fadet"]')
          .getAttribute('href')
        const detailed = detailedFilepath.match('detail') ? true : false
        const detailedBill = {
          ...computedBill
        }
        detailedBill.fileurl = `${CLIENT_SPACE_URL}${detailedFilepath}`
        detailedBill.filename = await getFileName(
          dateArray,
          amount,
          currency,
          detailed,
          fileurl
        )
        oldBills.push(detailedBill)
      }
      counter++
      oldBills.push(computedBill)
    }
    this.log('debug', 'Old bills fetched')
    return oldBills
  }

  async findAltOldBills(contractName) {
    this.log('info', '📍️ findAltOldBill starts')
    let oldBills = []
    const allBillsElements = document
      .querySelector('#historique')
      .querySelectorAll('.sr-container-content-line')
    let counter = 0
    for (const oneBill of allBillsElements) {
      this.log(
        'info',
        `fetching bill ${counter + 1}/${allBillsElements.length}...`
      )
      const rawAmount = oneBill.children[0].querySelector('span').innerHTML
      const fullAmount = rawAmount
        .replace(/&nbsp;/g, '')
        .replace(/ /g, '')
        .replace(/\n/g, '')
      const amount = parseFloat(fullAmount.replace('€', '').replace(',', '.'))
      const currency = fullAmount.replace(/[0-9]*/g, '').replace(',', '')
      const datesElements = Array.from(oneBill.children).filter(
        element => element.tagName === 'SPAN'
      )
      const filepath = oneBill.querySelector('a').getAttribute('href')
      const fileurl = `${CLIENT_SPACE_URL}${filepath}`
      let computedBill = {
        amount,
        currency: currency === '€' ? 'EUR' : currency,
        vendor: 'sfr',
        fileurl,
        subPath: contractName,
        fileAttributes: {
          metadata: {
            contentAuthor: 'sfr',
            datetimeLabel: 'issueDate',
            isSubscription: true,
            issueDate: new Date(),
            carbonCopy: true
          }
        }
      }

      if (datesElements.length >= 2) {
        this.log('info', 'Found a payment date')
        const rawPaymentDate =
          datesElements[0].innerHTML.match(/\d{2}\/\d{2}\/\d{4}/g)[0]
        const foundDate = rawPaymentDate.replace(/\//g, '-').trim()
        const [paymentDay, paymentMonth, paymentYear] = foundDate.split('-')
        const paymentDate = new Date(
          `${paymentMonth}/${paymentDay}/${paymentYear}`
        )
        const innerhtmlIssueDate = datesElements[1].innerHTML
        const foundIssueDate = innerhtmlIssueDate.split('-')[1].trim()
        const [issueDay, issueMonth, issueYear] = foundIssueDate.split(/\//g)
        const issueDate = new Date(`${issueMonth}/${issueDay}/${issueYear}`)
        computedBill.paymentDate = paymentDate
        computedBill.date = issueDate
        computedBill.fileAttributes.metadata.datetime = issueDate
        computedBill.filename = await getFileName(
          [issueDay, issueMonth, issueYear],
          amount,
          currency
        )
      } else {
        this.log('info', 'Only one element present')
        const elementInnerhtml = datesElements[0].innerHTML
        if (elementInnerhtml.includes('Payé le')) {
          const [innerhtmlPaymentDate, innerhtmlIssueDate] =
            elementInnerhtml.split('- </span>')

          const foundPaymentDate = innerhtmlPaymentDate
            .split('le')[1]
            .replace('</span>', '')
            .trim()
          const [paymentDay, paymentMonth, paymentYear] =
            foundPaymentDate.split('/')
          const paymentDate = new Date(
            `${paymentMonth}/${paymentDay}/${paymentYear}`
          )

          const foundIssueDate = innerhtmlIssueDate
            .split('mensuelle -')[1]
            .replace('</span>', '')
            .trim()
          const [issueDay, issueMonth, issueYear] = foundIssueDate.split(/\//g)
          const issueDate = new Date(`${issueMonth}/${issueDay}/${issueYear}`)
          computedBill.paymentDate = paymentDate
          computedBill.date = issueDate
          computedBill.fileAttributes.metadata.datetime = issueDate
          computedBill.filename = await getFileName(
            [issueDay, issueMonth, issueYear],
            amount,
            currency
          )
        } else {
          this.log('info', 'Element does not includes "payé le"')
          const foundIssueDate = elementInnerhtml.split('-')[1].trim()
          const [issueDay, issueMonth, issueYear] = foundIssueDate.split(/\//g)
          const issueDate = new Date(`${issueMonth}/${issueDay}/${issueYear}`)
          computedBill.date = issueDate
          computedBill.fileAttributes.metadata.datetime = issueDate
          computedBill.filename = await getFileName(
            [issueDay, issueMonth, issueYear],
            amount,
            currency
          )
        }
      }
      oldBills.push(computedBill)
      counter++
    }
    this.log('debug', 'Old bills fetched')
    return oldBills
  }

  async checkPersonnalInfosLinkAvailability() {
    this.log('info', '📍️ checkPersonnalInfosLinkAvailability starts')
    // Looks like its some kind of identifier used in href's attributes for 'a' elements
    const redMLS = document
      .querySelector('body')
      .innerHTML.match(/<!--MLS=.*-->/g)[0]
      .split('MLS=')[1]
      .replace('-->', '')
    const infoPersoElement = document.querySelector(
      `a[href="//www.sfr.fr/mon-espace-client/redirect.html?e=${redMLS}&U=https%3A//espace-client-red.sfr.fr/infospersonnelles/contrat/informations/%3Fred%3D1"]`
    )
    if (infoPersoElement) {
      return redMLS
    } else {
      this.log(
        'info',
        "infoPerso element not visible, can't access the info page"
      )
      return false
    }
  }
}

const connector = new RedContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'getUserMail',
      'getContracts',
      'getMoreBills',
      'getBills',
      'getIdentity',
      'waitForSfrUrl',
      'isSfrUrl',
      'checkPersonnalInfosLinkAvailability'
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
