const Buffer = require('safe-buffer').Buffer
const async = require('async')
const ethUtil = require('ethereumjs-util')
const Bloom = require('./bloom.js')
const rlp = ethUtil.rlp
const Trie = require('merkle-patricia-tree')
const BN = ethUtil.BN

/**
 * process the transaction in a block and pays the miners
 * @param opts
 * @param opts.block {Block} the block we are processing
 * @param opts.generate {Boolean} [gen=false] whether to generate the stateRoot
 * @param cb {Function} the callback which is given an error string
 */
module.exports = function (opts, cb) {
  if (typeof opts === 'function' && cb === undefined) {
    cb = opts
    return cb(new Error('invalid input, opts must be provided'))
  }
  if (!opts.block) {
    return cb(new Error('invalid input, block must be provided'))
  }

  const self = this

  // parse options
  const block = opts.block
  const generateStateRoot = !!opts.generate
  const validateStateRoot = !generateStateRoot
  const bloom = new Bloom()
  const receiptTrie = new Trie()
  // the total amount of gas used processing this block
  var gasUsed = new BN(0)
  var receipts = []
  var txResults = []
  var result

  if (opts.root) {
    self.stateManager.trie.root = opts.root
  }

  self.stateManager.trie.checkpoint()

  // run everything
  async.series([
    beforeBlock,
    processTransactions,
    payOmmersAndMiner
  ], parseBlockResults)

  function beforeBlock (cb) {
    self.emit('beforeBlock', opts.block, cb)
  }

  function afterBlock (cb) {
    self.emit('afterBlock', result, cb)
  }

  /**
   * Processes all of the transaction in the block
   * @method processTransaction
   * @param {Function} cb the callback is given error if there are any
   */
  function processTransactions (cb) {
    var validReceiptCount = 0

    async.eachSeries(block.transactions, processTx, cb)

    function processTx (tx, cb) {
      var gasLimitIsHigherThanBlock = new BN(block.header.gasLimit).lt(new BN(tx.gasLimit).add(gasUsed))
      if (gasLimitIsHigherThanBlock) {
        cb(new Error('tx has a higher gas limit than the block'))
        return
      }

      // run the tx through the VM
      self.runTx({
        tx: tx,
        block: block
      }, parseTxResult)

      function parseTxResult (err, result) {
        txResults.push(result)
        // var receiptResult = new BN(1)

        // abort if error
        if (err) {
          receipts.push(null)
          cb(err)
          return
        }

        gasUsed = gasUsed.add(result.gasUsed)
        // combine blooms via bitwise OR
        bloom.or(result.bloom)

        if (generateStateRoot) {
          block.header.bloom = bloom.bitvector
        }

        var txLogs = result.vm.logs || []

        var rawTxReceipt = [
          result.vm.exception ? 1 : 0, // result.vm.exception is 0 when an exception occurs, and 1 when it doesn't.  TODO make this the opposite
          gasUsed.toArrayLike(Buffer),
          result.bloom.bitvector,
          txLogs
        ]
        var txReceipt = {
          status: rawTxReceipt[0],
          gasUsed: rawTxReceipt[1],
          bitvector: rawTxReceipt[2],
          logs: rawTxReceipt[3]
        }

        receipts.push(txReceipt)
        receiptTrie.put(rlp.encode(validReceiptCount), rlp.encode(rawTxReceipt), function () {
          validReceiptCount++
          cb()
        })
      }
    }
  }

    // credit all block rewards
  function payOmmersAndMiner (cb) {
    var ommers = block.uncleHeaders

      // pay each ommer
    async.series([
      rewardOmmers,
      rewardMiner
    ], cb)

    function rewardOmmers (done) {
      async.each(block.uncleHeaders, function (ommer, next) {
          // calculate reward
        var minerReward = new BN(self._common.param('pow', 'minerReward'))
        var heightDiff = new BN(block.header.number).sub(new BN(ommer.number))
        var reward = ((new BN(8)).sub(heightDiff)).mul(minerReward.divn(8))

        if (reward.ltn(0)) {
          reward = new BN(0)
        }

        rewardAccount(ommer.coinbase, reward, next)
      }, done)
    }

    function rewardMiner (done) {
        // calculate nibling reward
      var minerReward = new BN(self._common.param('pow', 'minerReward'))
      var niblingReward = minerReward.divn(32)
      var totalNiblingReward = niblingReward.muln(ommers.length)
      var reward = minerReward.add(totalNiblingReward)
      rewardAccount(block.header.coinbase, reward, done)
    }

    function rewardAccount (address, reward, done) {
      self.stateManager.getAccount(address, function (err, account) {
        if (err) return done(err)
          // give miner the block reward
        account.balance = new BN(account.balance).add(reward)
        self.stateManager.putAccount(address, account, done)
      })
    }
  }

  // handle results or error from block run
  function parseBlockResults (err) {
    if (err) {
      self.stateManager.trie.revert()
      cb(err)
      return
    }

    // credit all block rewards
    if (generateStateRoot) {
      block.header.stateRoot = self.stateManager.trie.root
    }

    self.stateManager.trie.commit(function (err) {
      self.stateManager.cache.flush(function () {
        if (validateStateRoot) {
          if (receiptTrie.root && receiptTrie.root.toString('hex') !== block.header.receiptTrie.toString('hex')) {
            err = new Error((err || '') + 'invalid receiptTrie ')
          }
          if (bloom.bitvector.toString('hex') !== block.header.bloom.toString('hex')) {
            err = new Error((err || '') + 'invalid bloom ')
          }
          if (ethUtil.bufferToInt(block.header.gasUsed) !== Number(gasUsed)) {
            err = new Error((err || '') + 'invalid gasUsed ')
          }
          if (self.stateManager.trie.root.toString('hex') !== block.header.stateRoot.toString('hex')) {
            err = new Error((err || '') + 'invalid block stateRoot ')
          }
        }

        self.stateManager.cache.clear()

        result = {
          receipts: receipts,
          results: txResults,
          error: err
        }

        afterBlock(cb.bind(this, err, result))
      })
    })
  }
}
