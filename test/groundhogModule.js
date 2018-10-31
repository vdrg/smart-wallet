const utils = require('./utils')
const solc = require('solc')
const ethjsabi = require('ethereumjs-abi');
const CreateAndAddModules = artifacts.require("./libraries/CreateAndAddModules.sol");
const GnosisSafe = artifacts.require("./GnosisSafe.sol")
const GroundhogModule = artifacts.require("./modules/GroundhogModule.sol")
const ProxyFactory = artifacts.require("./ProxyFactory.sol")
const GAS_PRICE = web3.toWei(100, 'gwei');



contract('GroundhogModule', function (accounts) {

    let gnosisSafe
    let groundhogModule
    let lw
    let executor = accounts[8]

    const CALL = 0

    let signTypedData = async function (account, data) {
        return new Promise(function (resolve, reject) {
            web3.currentProvider.sendAsync({
                method: "eth_signTypedData",
                params: [account, data],
                from: account
            }, function (err, response) {
                if (err) {
                    return reject(err);
                }
                console.log(response);
                resolve(response.result);
            });
        });
    }

    let signer = async function (confirmingAccounts, to, value, data, operation, txGasEstimate, dataGasEstimate, gasPrice, txGasToken, meta) {
        let typedData = {
            types: {
                EIP712Domain: [
                    {type: "address", name: "verifyingContract"}
                ],
                // "SafeSubTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 dataGas,uint256 gasPrice,address gasToken,bytes meta)"
                SafeSubTx: [
                    {type: "address", name: "to"},
                    {type: "uint256", name: "value"},
                    {type: "bytes", name: "data"},
                    {type: "uint8", name: "operation"},
                    {type: "uint256", name: "safeTxGas"},
                    {type: "uint256", name: "dataGas"},
                    {type: "uint256", name: "gasPrice"},
                    {type: "address", name: "gasToken"},
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
                meta: meta
            }
        };

        let signatureBytes = "0x"
        confirmingAccounts.sort();
        for (var i = 0; i < confirmingAccounts.length; i++) {
            signatureBytes += (await signTypedData(confirmingAccounts[i], typedData)).replace('0x', '')
        }
        return signatureBytes
    }


    let estimateDataGas = function (to, value, data, operation, txGasEstimate, gasToken, meta, signatureCount) {
        // numbers < 256 are 192 -> 31 * 4 + 68
        // numbers < 65k are 256 -> 30 * 4 + 2 * 68
        // For signature array length and dataGasEstimate we already calculated the 0 bytes so we just add 64 for each non-zero byte
        let signatureCost = signatureCount * (68 + 2176 + 2176) // array count (3 -> r, s, v) * signature count
        let payload = groundhogModule.contract.execSubscription.getData(
            to, value, data, operation, txGasEstimate, 0, GAS_PRICE, gasToken, meta, "0x"
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
        let options = opts || {};
        let txFailed = options.fails || false;
        let txGasToken = options.gasToken || 0;
         let meta = options.meta || ethjsabi.rawEncode(['address', 'uint256'],[accounts[0], 1]);
        //let meta = options.meta || [ethjsabi.rawEncode(['address'], [accounts[0]]), ethjsabi.rawEncode(['uint256'],[1])]
        console.log(meta);
        // Estimate safe transaction (need to be called with from set to the safe address)
        let txGasEstimate = 0
        // let manager = await groundhogModule.contract.manager();
        try {
            let estimateData = groundhogModule.contract.requiredTxGas.getData(to, value, data, operation)
            let estimateResponse = await web3.eth.call({to: groundhogModule.address, from: groundhogModule.address, data: estimateData})
            txGasEstimate = new BigNumber(estimateResponse.substring(138), 16)
            // Add 10k else we will fail in case of nested calls
            txGasEstimate = txGasEstimate.toNumber() + 10000
            console.log("    Tx Gas estimate: " + txGasEstimate)
        } catch (e) {
            console.log("    Could not estimate " + subject)
        }

        let dataGasEstimate = estimateDataGas(to, value, data, operation, txGasEstimate, txGasToken, meta, accounts.length)
        console.log("    Data Gas estimate: " + dataGasEstimate)

        let gasPrice = GAS_PRICE
        if (txGasToken !== 0) {
            gasPrice = 1
        }
        let sigs = await signer(accounts, to, value, data, operation, txGasEstimate, dataGasEstimate, gasPrice, txGasToken, meta);

        // let payload = await groundhogModule.contract.execSubscription.getData(
        //     to, value, data, operation, txGasEstimate, dataGasEstimate, gasPrice, txGasToken, meta, sigs
        // )
        // console.log("    Data costs: " + utils.estimateDataGasCosts(payload))

        // // Estimate gas of paying transaction
        // let estimate = await groundhogModule.contract.execSubscription.estimateGas(
        //     to, value, data, operation, txGasEstimate, dataGasEstimate, gasPrice, txGasToken, meta, sigs
        // );

        // Execute paying transaction
        // We add the txGasEstimate and an additional 10k to the estimate to ensure that there is enough gas for the safe transaction
        let tx = groundhogModule.contract.execSubscription(
            to, value, data, operation, txGasEstimate, dataGasEstimate, gasPrice, txGasToken, meta, sigs, {from: executor, gasLimit:400000}
        )
        console.log(tx);
        // let events = utils.checkTxEvent(tx, 'ExecutionFailed', groundhogModule.address, txFailed, subject);
        // if (txFailed) {
        //     let subHash = await groundhogModule.contract.getSubscriptionHash(to, value, data, operation, txGasEstimate, dataGasEstimate, gasPrice, txGasToken, meta)
        //     assert.equal(subHash, events.args.subHash)
        // }
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
        // lw = await utils.createLightwallet()
        // Create libraries
        let createAndAddModules = await CreateAndAddModules.new()
        // Create Master Copies
        let proxyFactory = await ProxyFactory.new()
        let gnosisSafeMasterCopy = await GnosisSafe.new()
        gnosisSafeMasterCopy.setup([accounts[0], accounts[1], accounts[2]], 2, 0, "0x")
        let groundhogModuleMasterCopy = await GroundhogModule.new()

        // State channel module setup
        let groundhogSetupData = await groundhogModuleMasterCopy.contract.setup.getData()
        let groundhogCreationData = await proxyFactory.contract.createProxy.getData(groundhogModuleMasterCopy.address, groundhogSetupData)

        let modulesCreationData = utils.createAndAddModulesData([groundhogCreationData])
        let createAndAddModulesData = createAndAddModules.contract.createAndAddModules.getData(proxyFactory.address, modulesCreationData)

        // Create Gnosis Safe
        let gnosisSafeData = await gnosisSafeMasterCopy.contract.setup.getData([accounts[0], accounts[1], accounts[2]], 2, createAndAddModules.address, createAndAddModulesData)
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
        await executeSubscriptionWithSigner(signer, 'executeTransaction withdraw 0.5 ETH', confirmingAccounts, accounts[9], web3.toWei(1, 'ether'), "0x", CALL, executor)
        //await executeSubscription('executeTransaction withdraw 0.5 ETH', [lw.accounts[0], lw.accounts[2]], accounts[9], web3.toWei(0.5, 'ether'), "0x", CALL);

        //await executeSubscription('executeTransaction withdraw 0.5 ETH', [lw.accounts[0], lw.accounts[2]], accounts[9], web3.toWei(0.5, 'ether'), "0x", CALL, true);


        // Should fail its not time to withdraw again
        // await executeSubscriptionWithSigner(signer, 'executeTransaction withdraw 0.5 ETH', confirmingAccounts, accounts[9], web3.toWei(0.5, 'ether'), "0x", CALL, executor, {fails: true})

        let executorDiff = await web3.eth.getBalance(executor) - executorBalance
        console.log("    Executor earned " + web3.fromWei(executorDiff, 'ether') + " ETH");
        assert.ok(executorDiff > 0)
    })


    let executeSubscription = async function(subject, accounts, to, value, data, operation, failing) {
        failing = failing || false;

        let meta = [accounts[0], 0x0000000000000001];
        //0xf17f52151ebef6c7334fad080c5704d77216b732
        // groundhogModule.contract.execSubscription.getData(
        //     to, value, data, operation, txGasEstimate, dataGasEstimate, gasPrice, txGasToken, meta, sigs
        // )
        let txGasEstimate = 0;
        let dataGasEstimate = 0;

        let txGasToken = 0;

        let subscriptionHash = await groundhogModule.contract.getSubscriptionHash(to, value, data, operation, txGasEstimate, dataGasEstimate, GAS_PRICE, txGasToken, meta)

        // Confirm transaction with signed messages
        let sigs = utils.signTransaction(lw, accounts, subscriptionHash);


        // Execute paying transaction
        // We add the minGasEstimate and an additional 10k to the estimate to ensure that there is enough gas for the safe transaction
        let tx = groundhogModule.contract.execSubscription(
            to, value, data, operation, txGasEstimate, dataGasEstimate, GAS_PRICE, txGasToken, meta, sigs, {from: executor}
        );

        let res;
        if (failing) {
            res = await utils.assertRejects(
                tx,
                subject
            )
        } else {
            res = await tx;
            utils.logGasUsage(subject, res)
        }

        return res
    }

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
