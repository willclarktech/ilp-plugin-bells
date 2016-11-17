'use strict'

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
chai.should()

const assert = chai.assert

const mock = require('mock-require')
const nock = require('nock')
const wsHelper = require('./helpers/ws')
const cloneDeep = require('lodash/cloneDeep')

mock('ws', wsHelper.WebSocket)
const PluginBellsFactory = require('..').Factory

describe('PluginBellsFactory', function () {
  beforeEach(function * () {
    this.wsRedLedger = wsHelper.makeServer('ws://red.example/websocket?token=abc')
    this.infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))

    nock('http://red.example')
      .get('/accounts/admin')
      .reply(200, {
        ledger: 'http://red.example',
        name: 'admin'
      })

    const infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))

    nock('http://red.example')
      .get('/')
      .reply(200, infoRedLedger)

    nock('http://red.example')
      .get('/')
      .reply(200, infoRedLedger)

    nock('http://red.example')
      .get('/auth_token')
      .reply(200, {token: 'abc'})

    this.transfer = {
      id: 'ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
      direction: 'incoming',
      account: 'example.red.alice',
      amount: '10',
      expiresAt: (new Date((new Date()).getTime() + 1000)).toISOString()
    }

    this.fiveBellsTransferAlice = {
      id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
      ledger: 'http://red.example',
      debits: [{
        account: 'http://red.example/accounts/mike',
        amount: '10',
        authorized: true
      }],
      credits: [{
        account: 'http://red.example/accounts/alice',
        amount: '10'
      }],
      expires_at: this.transfer.expiresAt
    }

    this.fiveBellsTransferMike = {
      id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
      ledger: 'http://red.example',
      debits: [{
        account: 'http://red.example/accounts/alice',
        amount: '10'
      }],
      credits: [{
        account: 'http://red.example/accounts/mike',
        amount: '10'
      }],
      state: 'executed'
    }

    this.fiveBellsMessage = cloneDeep(require('./data/message.json'))
    this.message = {
      ledger: 'example.red.',
      account: 'example.red.alice',
      data: {foo: 'bar'}
    }

    this.factory = new PluginBellsFactory({
      adminUsername: 'admin',
      adminPassword: 'admin',
      adminAccount: 'http://red.example/accounts/admin',
      prefix: 'example.red.'
    })

    yield this.factory.connect()
    assert.isTrue(this.factory.isConnected())

    const nockMike = nock('http://red.example')
      .get('/accounts/mike')
      .reply(200, {
        ledger: 'http://red.example',
        name: 'admin'
      })

    this.plugin = yield this.factory.create({ username: 'mike' })
    assert.isOk(this.factory.plugins.get('mike'))

    nockMike.done()
  })

  afterEach(function * () {
    this.wsRedLedger.stop()
    assert(nock.isDone(), 'all nocks should be called')
  })

  describe('connect', function () {
    it('will not connect twice', function * () {
      yield this.factory.connect()
      assert.isTrue(this.factory.isConnected())
    })

    it('disconnects', function * () {
      yield this.factory.disconnect()
      assert.isFalse(this.factory.isConnected())
    })

    it('will pass a notification to the correct plugin', function * () {
      const handled = new Promise((resolve, reject) => {
        this.plugin.on('incoming_transfer', resolve)
      })

      this.wsRedLedger.send(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'notify',
        params: {
          event: 'transfer.update',
          resource: this.fiveBellsTransferMike,
          related_resources: {}
        }
      }))

      yield handled
    })

    it('will pass a message to the correct plugin', function * () {
      const handled = new Promise((resolve, reject) => {
        this.plugin.on('incoming_message', resolve)
      })

      this.wsRedLedger.send(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'notify',
        params: {
          event: 'message.send',
          resource: {
            ledger: 'http://red.example',
            to: 'http://red.example/accounts/mike',
            from: 'http://red.example/accounts/alice',
            data: {}
          },
          related_resources: {}
        }
      }))

      yield handled
    })

    it('send a message as the correct username', function * () {
      nock('http://red.example')
        .post('/messages', {
          from: 'http://red.example/accounts/mike',
          to: 'http://red.example/accounts/alice',
          ledger: 'http://red.example',
          data: { foo: 'bar' }
        })
        .basicAuth({user: 'admin', pass: 'admin'})
        .reply(200)

      yield this.plugin.sendMessage({
        ledger: 'example.red.',
        account: 'example.red.alice',
        data: { foo: 'bar' }
      })
    })

    it('sends a transfer with the correct fields', function * () {
      nock('http://red.example')
        .put('/transfers/' + this.transfer.id, this.fiveBellsTransferAlice)
        .basicAuth({user: 'admin', pass: 'admin'})
        .reply(200)

      yield this.plugin.sendTransfer(this.transfer)
    })
  })

  describe('create', function () {
    it('will not create a nonexistant account', function * () {
      const nockBob = nock('http://red.example')
        .get('/accounts/bob')
        .reply(404, {})

      try {
        yield this.factory.create({ username: 'bob' })
        assert(false, 'factory create should have failed')
      } catch (e) {
        nockBob.done()
        assert.isTrue(true)
      }
    })

    it('will create a plugin', function * () {
      assert.isObject(this.plugin)
      assert.isTrue(this.plugin.isConnected())

      const plugin = yield this.factory.create({ username: 'mike' })
      assert.equal(this.plugin, plugin, 'only one plugin should be made per account')
    })

    it('subscribes to the new account', function (done) {
      nock('http://red.example')
        .get('/accounts/mary')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'admin'
        })

      this.wsRedLedger.on('message', (rpcMessageString) => {
        const rpcMessage = JSON.parse(rpcMessageString)
        assert.deepEqual(rpcMessage, {
          jsonrpc: '2.0',
          id: 3,
          method: 'subscribe_account',
          params: {
            eventType: '*',
            accounts: ['http://red.example/accounts/mike', 'http://red.example/accounts/mary']
          }
        })
        done()
      })
      this.factory.create({ username: 'mary' }).catch(done)
    })

    it('will throw if given an invalid opts.username', function (done) {
      this.factory.create({ username: 'foo!' }).catch((err) => {
        assert.equal(err.message, 'Invalid opts.username')
        done()
      })
    })
  })

  describe('remove', function () {
    it('removes a plugin', function * () {
      yield this.factory.remove('mike')
      assert.isNotOk(this.factory.plugins.get('mike'))
    })
  })
})
