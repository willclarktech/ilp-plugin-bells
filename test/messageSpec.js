'use strict'

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
chai.should()

const assert = chai.assert

const mock = require('mock-require')
const nock = require('nock')
const wsHelper = require('./helpers/ws')
const errors = require('../src/errors')
const cloneDeep = require('lodash/cloneDeep')
const _ = require('lodash')
const InvalidFieldsError = require('../src/errors').InvalidFieldsError

mock('ws', wsHelper.WebSocket)
const PluginBells = require('..')

describe('Messaging', function () {
  beforeEach(function * () {
    this.plugin = new PluginBells({
      prefix: 'example.red.',
      account: 'http://red.example/accounts/mike',
      password: 'mike',
      debugReplyNotifications: true,
      debugAutofund: {
        connector: 'http://mark.example',
        admin: {username: 'adminuser', password: 'adminpass'}
      }
    })

    this.nockAccount = nock('http://red.example')
      .get('/accounts/mike')
      .reply(200, {
        ledger: 'http://red.example',
        name: 'mike'
      })

    this.infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))
    this.ledgerMessage = cloneDeep(require('./data/message.json'))
    this.message = {
      ledger: 'example.red.',
      account: 'example.red.alice',
      data: {foo: 'bar'}
    }

    nock('http://red.example')
      .get('/auth_token')
      .reply(200, {token: 'abc'})

    this.nockInfo = nock('http://red.example')
      .get('/')
      .reply(200, this.infoRedLedger)

    this.wsRedLedger = wsHelper.makeServer('ws://red.example/websocket?token=abc')

    yield this.plugin.connect()
  })

  afterEach(function * () {
    this.wsRedLedger.stop()
    assert(nock.isDone(), 'nocks should all have been called')
  })

  describe('sendMessage', function () {
    it('submits a message', function * () {
      nock('http://red.example')
        .post('/messages', this.ledgerMessage)
        .query({token: 'abc'})
        .reply(200)
      yield assert.isFulfilled(this.plugin.sendMessage(this.message), null)
    })

    it('submits a message with "to" instead of "account"', function * () {
      nock('http://red.example')
        .post('/messages', this.ledgerMessage)
        .query({token: 'abc'})
        .reply(200)

      this.message.to = this.message.account
      delete this.message.account

      yield assert.isFulfilled(this.plugin.sendMessage(this.message), null)
    })

    it('should use the message url from the ledger metadata', function * () {
      nock.removeInterceptor(this.nockInfo)
      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {token: 'abc'})
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      const nockInfo = nock('http://red.example')
        .get('/')
        .reply(200, _.merge(this.infoRedLedger, {
          urls: {
            message: 'http://red.example/other/place/to/submit/messages'
          }
        }))
      const messageNock = nock('http://red.example')
        .post('/other/place/to/submit/messages')
        .query({token: 'abc'})
        .reply(200)
      const plugin = new PluginBells({
        prefix: 'example.red.',
        account: 'http://red.example/accounts/mike',
        password: 'mike',
        debugReplyNotifications: true,
        debugAutofund: {
          connector: 'http://mark.example',
          admin: {username: 'adminuser', password: 'adminpass'}
        }
      })
      yield plugin.connect()

      yield plugin.sendMessage(this.message)

      nockInfo.done()
      messageNock.done()
    })

    it('throws InvalidFieldsError for missing to field', function (done) {
      this.plugin.sendMessage({
        ledger: 'example.red.',
        data: {}
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid to field').notify(done)
    })

    it('throws InvalidFieldsError for missing ledger', function (done) {
      this.plugin.sendMessage({
        account: 'example.red.alice',
        data: {}
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid ledger').notify(done)
    })

    it('throws InvalidFieldsError for incorrect ledger', function (done) {
      this.plugin.sendMessage({
        ledger: 'example.blue.',
        account: 'example.red.alice',
        data: {}
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid ledger').notify(done)
    })

    it('throws InvalidFieldsError for missing data', function (done) {
      this.plugin.sendMessage({
        ledger: 'example.red.',
        account: 'example.red.alice'
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid data').notify(done)
    })

    it('rejects a message when the destination does not begin with the correct prefix', function * () {
      yield assert.isRejected(this.plugin.sendMessage({
        ledger: 'example.red.',
        account: 'red.alice',
        data: {foo: 'bar'}
      }), InvalidFieldsError, /^Destination address "red.alice" must start with ledger prefix "example.red."$/)
    })

    it('throws an InvalidFieldsError on InvalidBodyError', function (done) {
      nock('http://red.example')
        .post('/messages')
        .query({token: 'abc'})
        .reply(400, {id: 'InvalidBodyError', message: 'fail'})

      this.plugin.sendMessage(this.message)
        .should.be.rejectedWith(errors.InvalidFieldsError, 'fail').notify(done)
    })

    it('throws a NoSubscriptionsError', function (done) {
      nock('http://red.example')
        .post('/messages', this.ledgerMessage)
        .query({token: 'abc'})
        .reply(422, {id: 'NoSubscriptionsError', message: 'fail'})

      this.plugin.sendMessage(this.message)
        .should.be.rejectedWith(errors.NoSubscriptionsError, 'fail').notify(done)
    })

    it('throws an NotAcceptedError on 400', function (done) {
      nock('http://red.example')
        .post('/messages', this.ledgerMessage)
        .query({token: 'abc'})
        .reply(400, {id: 'SomeError', message: 'fail'})

      this.plugin.sendMessage(this.message)
        .should.be.rejectedWith(errors.NotAcceptedError, 'fail').notify(done)
    })

    it('throws an Error when not connected', function (done) {
      const plugin = new PluginBells({
        prefix: 'example.red.',
        account: 'http://red.example/accounts/mike',
        password: 'mike'
      })
      plugin.sendMessage(this.message)
        .should.be.rejectedWith(Error, 'Must be connected before sendMessage can be called').notify(done)
    })
  })
})
