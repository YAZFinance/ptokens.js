import Web3 from 'web3'
import Web3PromiEvent from 'web3-core-promievent'
import { NodeSelector } from 'ptokens-node-selector'
import { constants, eth, ltc, helpers, abi, redeemFrom } from 'ptokens-utils'
import { DepositAddress } from 'ptokens-deposit-address'
import Web3Utils from 'web3-utils'
import * as bitcoin from 'bitcoinjs-lib'

const MINIMUM_LTC_REDEEMABLE = 0.00005
const LTC_INSIGHT_POLLING_TIME = 3000

export class pLTC extends NodeSelector {
  /**
   * @param {Object} _configs
   */
  constructor(_configs) {
    const {
      hostBlockchain,
      hostNetwork,
      nativeBlockchain,
      nativeNetwork
    } = helpers.parseParams(_configs, constants.blockchains.Litecoin)

    super({
      pToken: constants.pTokens.pLTC,
      hostBlockchain,
      hostNetwork,
      nativeBlockchain,
      nativeNetwork,
      defaultEndpoint: _configs.defaultEndpoint
    })

    const { ethPrivateKey, ethProvider } = _configs

    // NOTE: parse eth params
    if (ethProvider) this.hostApi = new Web3(ethProvider)
    if (ethPrivateKey) {
      const account = this.hostApi.eth.accounts.privateKeyToAccount(
        eth.addHexPrefix(ethPrivateKey)
      )

      this.hostApi.eth.defaultAccount = account.address
      this.hostPrivateKey = eth.addHexPrefix(ethPrivateKey)
    } else {
      this.hostPrivateKey = null
    }

    this.contractAddress = null
    this.decimals = null
  }

  /**
   * @param {String} _hostAddress
   */
  async getDepositAddress(_hostAddress) {
    if (
      this.hostBlockchain === constants.blockchains.Ethereum &&
      !Web3Utils.isAddress(_hostAddress)
    )
      throw new Error('Eth Address is not valid')

    const selectedNode = this.selectedNode
      ? this.selectedNode
      : await this.select()
    if (!selectedNode) {
      throw new Error(
        'No node selected. Impossible to generate a BTC deposit Address.'
      )
    }

    const depositAddress = new DepositAddress({
      node: selectedNode,
      nativeBlockchain: this.nativeBlockchain,
      nativeNetwork: this.nativeNetwork,
      hostBlockchain: this.hostBlockchain,
      hostNetwork: this.hostNetwork,
      hostApi: this.hostApi
    })

    await depositAddress.generate(_hostAddress)

    if (!depositAddress.verify())
      throw new Error('Node deposit address does not match expected address')

    return depositAddress
  }

  /**
   * @param {Number} _amount
   * @param {String} _ltcAddress
   * @param {RedeemOptions} _options
   */
  redeem(_amount, _ltcAddress, _options = {}) {
    const promiEvent = Web3PromiEvent()

    const { gas, gasPrice } = _options

    const start = async () => {
      if (_amount < MINIMUM_LTC_REDEEMABLE) {
        promiEvent.reject(
          `Impossible to burn less than ${MINIMUM_LTC_REDEEMABLE} pLTC`
        )
        return
      }

      // NOTE: add support for p2sh testnet address (Q...)
      let ltcAddressToCheck = _ltcAddress
      const decoded = bitcoin.address.fromBase58Check(_ltcAddress)
      if (decoded.version === 0xc4)
        ltcAddressToCheck = bitcoin.address.toBase58Check(decoded.hash, 0x3a)

      if (
        !ltc.isValidAddress(
          helpers.getNetworkType(this.hostNetwork),
          ltcAddressToCheck
        )
      ) {
        promiEvent.reject('Ltc Address is not valid')
        return
      }

      try {
        if (!this.selectedNode) await this.select()

        const decimals = await this._getDecimals()
        const contractAddress = await this._getContractAddress()

        let hostTxReceiptId = null

        if (this.hostBlockchain === constants.blockchains.Ethereum) {
          const ethTxReceipt = await redeemFrom.redeemFromEthereum(
            this.hostApi,
            _amount,
            decimals,
            _ltcAddress,
            contractAddress,
            gas,
            gasPrice,
            this.hostPrivateKey
          )

          promiEvent.eventEmitter.emit('onEthTxConfirmed', ethTxReceipt)
          promiEvent.eventEmitter.emit('hostTxConfirmed', ethTxReceipt)

          hostTxReceiptId = ethTxReceipt.transactionHash
        }

        const broadcastedBtcTxReport = await this.selectedNode.monitorIncomingTransaction(
          hostTxReceiptId,
          promiEvent.eventEmitter
        )

        const broadcastedBtcTx = await ltc.waitForTransactionConfirmation(
          this.nativeNetwork,
          broadcastedBtcTxReport.broadcast_tx_hash,
          LTC_INSIGHT_POLLING_TIME
        )
        promiEvent.eventEmitter.emit('nativeTxConfirmed', broadcastedBtcTx)
        promiEvent.eventEmitter.emit('onLtcTxConfirmed', broadcastedBtcTx)

        promiEvent.resolve({
          amount: _amount.toFixed(decimals),
          to: _ltcAddress,
          tx: broadcastedBtcTxReport.broadcast_tx_hash
        })
      } catch (err) {
        promiEvent.reject(err)
      }
    }

    start()
    return promiEvent.eventEmitter
  }

  async _getContractAddress() {
    try {
      if (!this.contractAddress) {
        if (!this.selectedNode) await this.select()

        const { smart_contract_address } = await this.selectedNode.getInfo()
        this.contractAddress = smart_contract_address
      }

      return this.contractAddress
    } catch (_err) {
      throw new Error(`Error during getting contract address: ${_err.message}`)
    }
  }

  async _getDecimals() {
    try {
      if (!this.decimals) {
        if (this.hostBlockchain === constants.blockchains.Ethereum) {
          const contractAddress = !this.contractAddress
            ? await this._getContractAddress()
            : this._contractAddress

          this.decimals = await eth.makeContractCall(this.hostApi, 'decimals', {
            abi: abi.pTokenOnEth,
            contractAddress
          })
        }
      }
      return this.decimals
    } catch (_err) {
      throw new Error(`Error during getting decimals: ${_err.message}`)
    }
  }
}