const utils = require('./utils')
const solc = require('solc')

const CreateAndAddModules = artifacts.require("./libraries/CreateAndAddModules.sol");
const GnosisSafe = artifacts.require("./GnosisSafe.sol")
const GroundhogModule = artifacts.require("./modules/GroundhogModule.sol")
const ProxyFactory = artifacts.require("./ProxyFactory.sol")
const GAS_PRICE = web3.toWei(100, 'gwei')

contract('GroundhogModule', function (accounts) {

    let gnosisSafe
    let groundhogModule
    let lw
    let executor = accounts[8]

    const CALL = 0

    let signTypedData = async function (account, data) {
        return new Promise(function (resolve, reject) {
            web3.currentProvider.sendAsync({
                jsonrpc: "2.0",
                method: "eth_signTypedData",
                params: [account, data],
                id: new Date().getTime()
            }, function (err, response) {
                if (err) {
                    return reject(err);
                }
                resolve(response.result);
            });
        });
    }
    let signer = async function (confirmingAccounts, to, value, data, operation, txGasEstimate, dataGasEstimate, gasPrice, txGasToken, refundReceiver, meta) {
        let typedData = {
            types: {
                EIP712Domain: [
                    {type: "address", name: "verifyingContract"}
                ],
                // "SafeSubTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 dataGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"
                SafeSubTx: [
                    {type: "address", name: "to"},
                    {type: "uint256", name: "value"},
                    {type: "bytes", name: "data"},
                    {type: "uint8", name: "operation"},
                    {type: "uint256", name: "safeTxGas"},
                    {type: "uint256", name: "dataGas"},
                    {type: "uint256", name: "gasPrice"},
                    {type: "address", name: "gasToken"},
                    {type: "address", name: "refundReceiver"},
                    {type: "bytes", name: "meta"},
                ]
            },
            domain: {
                verifyingContract: groundhogModule.address
            },
            primaryType: "SafeSubTx",
            message: {
                to: to,
                value: value,
                data: data,
                operation: operation,
                safeTxGas: txGasEstimate,
                dataGas: dataGasEstimate,
                gasPrice: gasPrice,
                gasToken: txGasToken,
                refundReceiver: refundReceiver,
                meta: meta
            }
        };

        let signatureBytes = "0x"
        confirmingAccounts.sort()
        for (var i = 0; i < confirmingAccounts.length; i++) {
            signatureBytes += (await signTypedData(confirmingAccounts[i], typedData)).replace('0x', '')
        }
        return signatureBytes
    }


    let estimateDataGas = function (to, value, data, operation, txGasEstimate, gasToken, refundReceiver, meta, signatureCount) {
        // numbers < 256 are 192 -> 31 * 4 + 68
        // numbers < 65k are 256 -> 30 * 4 + 2 * 68
        // For signature array length and dataGasEstimate we already calculated the 0 bytes so we just add 64 for each non-zero byte
        let signatureCost = signatureCount * (68 + 2176 + 2176) // array count (3 -> r, s, v) * signature count
        let payload = groundhogModule.execSubscription.getData(
            to, value, data, operation, txGasEstimate, 0, GAS_PRICE, gasToken, refundReceiver, meta, "0x"
        )
        let dataGasEstimate = utils.estimateDataGasCosts(payload) + signatureCost
        if (dataGasEstimate > 65536) {
            dataGasEstimate += 64
        } else {
            dataGasEstimate += 128
        }
        return dataGasEstimate + 32000; // Add aditional gas costs (e.g. base tx costs, transfer costs)
    }

    let executeSubscriptionWithSigner = async function (signer, subject, accounts, to, value, data, operation, executor, opts) {
        let options = opts || {}
        let txFailed = options.fails || false
        let txGasToken = options.gasToken || 0
        //let refundReceiver = options.refundReceiver || 0

        // Estimate safe transaction (need to be called with from set to the safe address)
        let txGasEstimate = 0
        try {
            let estimateData = groundhogModule.requiredTxGas.getData(to, value, data, operation)
            let estimateResponse = await web3.eth.call({to: groundhogModule.address, from: groundhogModule.address, data: estimateData})
            txGasEstimate = new BigNumber(estimateResponse.substring(138), 16)
            // Add 10k else we will fail in case of nested calls
            txGasEstimate = txGasEstimate.toNumber() + 10000
            console.log("    Tx Gas estimate: " + txGasEstimate)
        } catch (e) {
            console.log("    Could not estimate " + subject)
        }
        let meta = [];

        let dataGasEstimate = estimateDataGas(to, value, data, operation, txGasEstimate, txGasToken, meta, accounts.length)
        console.log("    Data Gas estimate: " + dataGasEstimate)

        let gasPrice = GAS_PRICE
        if (txGasToken !== 0) {
            gasPrice = 1
        }
        let sigs = await signer(accounts, to, value, data, operation, txGasEstimate, dataGasEstimate, gasPrice, txGasToken, meta);

        let payload = groundhogModule.execSubscription.getData(
            to, value, data, operation, txGasEstimate, dataGasEstimate, gasPrice, txGasToken, meta, sigs
        )
        console.log("    Data costs: " + utils.estimateDataGasCosts(payload))

        // Estimate gas of paying transaction
        let estimate = await groundhogModule.execSubscription.estimateGas(
            to, value, data, operation, txGasEstimate, dataGasEstimate, gasPrice, txGasToken, meta, sigs
        );

        // Execute paying transaction
        // We add the txGasEstimate and an additional 10k to the estimate to ensure that there is enough gas for the safe transaction
        let tx = groundhogModule.execSubscription(
            to, value, data, operation, estimate, dataGasEstimate, gasPrice, txGasToken, meta, sigs, {from: executor}
        )
        let events = utils.checkTxEvent(tx, 'ExecutionFailed', groundhogModule.address, txFailed, subject);
        if (txFailed) {
            let subHash = await groundhogModule.getSubscriptionHash(to, value, data, operation, txGasEstimate, dataGasEstimate, gasPrice, txGasToken, meta)
            assert.equal(subHash, events.args.txHash)
        }
        return tx
    }

    // let executeTransaction = async function(subject, accounts, to, value, data, operation, safeTxGas, dataGas, gasPrice, gasToken, failing) {
    //     failing = failing || false
    //     let meta = [accounts[0]];
    //
    //     let subscriptionHash = await groundhogModule.getSubscriptionHash(to, value, data, operation, safeTxGas, dataGas, gasPrice, gasToken, meta)
    //
    //     // Confirm transaction with signed messages
    //     let sigs = utils.signTransaction(lw, accounts, subscriptionHash)
    //
    //     // Execute paying transaction
    //     // We add the minGasEstimate and an additional 10k to the estimate to ensure that there is enough gas for the safe transaction
    //     let tx = groundhogModule.execSubscription(
    //         to, value, data, operation, safeTxGas, dataGas, gasPrice, gasToken, meta, sigs, {from: executor}
    //     )
    //
    //     let res
    //     if (failing) {
    //         res = await utils.assertRejects(
    //             tx,
    //             subject
    //         )
    //     } else {
    //         res = await tx
    //         utils.logGasUsage(subject, res)
    //     }
    //
    //     return res
    // }

    beforeEach(async function () {
        // Create lightwallet
        lw = await utils.createLightwallet()
        // Create libraries
        let createAndAddModules = await CreateAndAddModules.new()
        // Create Master Copies
        let proxyFactory = await ProxyFactory.new()
        let gnosisSafeMasterCopy = await GnosisSafe.new()
        gnosisSafeMasterCopy.setup([lw.accounts[0], lw.accounts[1], lw.accounts[2]], 2, 0, "0x")
        let groundhogModuleMasterCopy = await GroundhogModule.new()

        // State channel module setup
        let groundhogSetupData = await groundhogModuleMasterCopy.contract.setup.getData()
        let groundhogCreationData = await proxyFactory.contract.createProxy.getData(groundhogModuleMasterCopy.address, groundhogSetupData)

        let modulesCreationData = utils.createAndAddModulesData([groundhogCreationData])
        let createAndAddModulesData = createAndAddModules.contract.createAndAddModules.getData(proxyFactory.address, modulesCreationData)

        // Create Gnosis Safe
        let gnosisSafeData = await gnosisSafeMasterCopy.contract.setup.getData([lw.accounts[0], lw.accounts[1], lw.accounts[2]], 2, createAndAddModules.address, createAndAddModulesData)
        gnosisSafe = utils.getParamFromTxEvent(
            await proxyFactory.createProxy(gnosisSafeMasterCopy.address, gnosisSafeData),
            'ProxyCreation', 'proxy', proxyFactory.address, GnosisSafe, 'create Gnosis Safe',
        )
        let modules = await gnosisSafe.getModules()
        groundhogModule = GroundhogModule.at(modules[0])
        assert.equal(await groundhogModule.manager.call(), gnosisSafe.address)
    })

    it('should deposit and withdraw 1 ETH', async () => {
        // Deposit 1 ETH + some spare money for execution
        assert.equal(await web3.eth.getBalance(gnosisSafe.address), 0)
        await web3.eth.sendTransaction({from: accounts[9], to: gnosisSafe.address, value: web3.toWei(1.1, 'ether')})
        assert.equal(await web3.eth.getBalance(gnosisSafe.address).toNumber(), web3.toWei(1.1, 'ether'))

        let executorBalance = await web3.eth.getBalance(executor).toNumber()

        let confirmingAccounts = [accounts[0], accounts[2]]


        // Withdraw 1 ETH
        await executeSubscriptionWithSigner(signer, 'executeTransaction withdraw 0.5 ETH', confirmingAccounts, accounts[9], web3.toWei(0.5, 'ether'), "0x", CALL, executor)

        // Should fail its not time to withdraw again
        await executeSubscriptionWithSigner(signer, 'executeTransaction withdraw 0.5 ETH', confirmingAccounts, accounts[9], web3.toWei(0.5, 'ether'), "0x", CALL, executor, {fails: true})

        let executorDiff = await web3.eth.getBalance(executor) - executorBalance
        console.log("    Executor earned " + web3.fromWei(executorDiff, 'ether') + " ETH");
        assert.ok(executorDiff > 0)
    })

    // it('should deposit and withdraw 1 ETH', async () => {
    //     // Deposit 1 ETH + some spare money for execution
    //     assert.equal(await web3.eth.getBalance(gnosisSafe.address), 0)
    //     await web3.eth.sendTransaction({from: accounts[0], to: gnosisSafe.address, value: web3.toWei(1, 'ether')})
    //     assert.equal(await web3.eth.getBalance(gnosisSafe.address).toNumber(), web3.toWei(1, 'ether'))
    //     // Should fail because there are not enough funds
    //     await executeTransaction('executeTransaction withdraw 2 ETH', [lw.accounts[0], lw.accounts[2]], accounts[0], web3.toWei(2, 'ether'), "0x", CALL, true)
    //
    //     // Withdraw 1 ETH
    //     await executeTransaction('executeTransaction withdraw 0.5 ETH', [lw.accounts[0], lw.accounts[2]], accounts[0], web3.toWei(0.5, 'ether'), "0x", CALL)
    //
    //     await executeTransaction('executeTransaction withdraw 0.5 ETH', [lw.accounts[0], lw.accounts[2]], accounts[0], web3.toWei(0.5, 'ether'), "0x", CALL)
    //
    //     assert.equal(await web3.eth.getBalance(gnosisSafe.address).toNumber(), web3.toWei(0, 'ether'))
    // })
})
