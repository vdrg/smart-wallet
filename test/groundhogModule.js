const utils = require('./utils')
const BigNumber = require('bignumber.js');
const timeHelper = require('./time');

const CreateAndAddModules = artifacts.require("./libraries/CreateAndAddModules.sol");
const GnosisSafe = artifacts.require("./GnosisSafe.sol")
const GroundhogModule = artifacts.require("./modules/GroundhogModule.sol")
const ProxyFactory = artifacts.require("./ProxyFactory.sol")
const GAS_PRICE = web3.toWei(20, 'gwei');



contract('GroundhogModule', function (accounts) {

    let gnosisSafe;
    let groundhogModule;
    let lw;
    let executor = accounts[8];
    let receiver = accounts[9];

    const CALL = 0;

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
                resolve(response.result);
            });
        });
    }

    let signer = async function (confirmingAccounts, to, value, data, operation, txGasEstimate, dataGasEstimate, gasPrice, txGasToken, refundAddress, meta) {
        let typedData = {
            types: {
                EIP712Domain: [
                    {type: "address", name: "verifyingContract"}
                ],
                // "SafeSubTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 dataGas,uint256 gasPrice,address gasToken, address refundAddress, bytes meta)"
                SafeSubTx: [
                    {type: "address", name: "to"},
                    {type: "uint256", name: "value"},
                    {type: "bytes", name: "data"},
                    {type: "uint8", name: "operation"},
                    {type: "uint256", name: "safeTxGas"},
                    {type: "uint256", name: "dataGas"},
                    {type: "uint256", name: "gasPrice"},
                    {type: "address", name: "gasToken"},
                    {type: "address", name: "refundAddress"},
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
                refundAddress: refundAddress,
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


    let estimateDataGas = function (to, value, data, operation, txGasEstimate, gasToken, meta, refundAddress, signatureCount) {
        // numbers < 256 are 192 -> 31 * 4 + 68
        // numbers < 65k are 256 -> 30 * 4 + 2 * 68
        // For signature array length and dataGasEstimate we already calculated the 0 bytes so we just add 64 for each non-zero byte
        let signatureCost = signatureCount * (68 + 2176 + 2176) // array count (3 -> r, s, v) * signature count
        let payload = groundhogModule.contract.execSubscription.getData(
            to, value, data, operation, txGasEstimate, 0, GAS_PRICE, gasToken, refundAddress, meta, "0x"
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
        let meta = options.meta || await groundhogModule.contract.getSubscriptionMetaBytes(1, 1, 0)
        // Estimate safe transaction (need to be called with from set to the safe address)
        //meta = meta.toHex();

        let txGasEstimate = 0
        // let manager = await groundhogModule.contract.manager();
        try {
            // let subhash = await groundhogModule.contract.getSubscriptionHash(to, value, data, operation, txGasEstimate, dataGasEstimate, gasPrice, txGasToken, executor, meta);
            let estimateData = groundhogModule.contract.requiredTxGas.getData(to, value, data, operation, meta);
            let estimateResponse = await web3.eth.call({to: groundhogModule.address, from: gnosisSafe.address, data: estimateData})
            txGasEstimate = new BigNumber(estimateResponse.substring(138), 16).toNumber()
            // Add 10k else we will fail in case of nested calls
            txGasEstimate = txGasEstimate + 90000
            console.log("    Tx Gas estimate: " + txGasEstimate)
        } catch (e) {
            console.log("    Could not estimate " + subject)
        }

        let dataGasEstimate = estimateDataGas(to, value, data, operation, txGasEstimate, txGasToken, meta, executor, accounts.length)
        console.log("    Data Gas estimate: " + dataGasEstimate)

        let gasPrice = GAS_PRICE
        if (txGasToken !== 0) {
            gasPrice = 1
        }



        let sigs = await signer(accounts, to, value, data, operation, txGasEstimate, dataGasEstimate, gasPrice, txGasToken, executor, meta);
        // console.log(`groundhog: ${gnosisSafe.address}`);
        // console.log(`groundhog: ${groundhogModule.address}`);
        // console.log(`to: ${to}`);
        // console.log(`value: ${value}`);
        // console.log(`data: ${data}`);
        // console.log(`operation: ${operation}`);
        // console.log(`txgases: ${txGasEstimate}`);
        // console.log(`datagasestimate: ${dataGasEstimate}`);
        // console.log(`gasprice: ${gasPrice}`);
        // console.log(`gastoken: ${txGasToken}`);
        // console.log(`refund: ${executor}`);
        // console.log(`meta: ${meta}`);
        // console.log(`Sigs: ${sigs}`)

        let safeBalanceBefore = await web3.eth.getBalance(gnosisSafe.address).toNumber();
        console.log(`    Balance Before: ${safeBalanceBefore}`)

        // Execute paying transaction
        // We add the txGasEstimate and an additional 10k to the estimate to ensure that there is enough gas for the safe transaction
        let tx = groundhogModule.execSubscription(
            to, value, data, operation, txGasEstimate, dataGasEstimate, gasPrice, txGasToken, executor, meta, sigs, {from: executor, gas:8000000}
        );

        return tx;
        // let events = utils.checkTxEvent(txreceipt, 'PaymentFailed', groundhogModule.address, txFailed, subject)
        // if (txFailed) {
        //     let subHash = await groundhogModule.getSubscriptionHash(accounts, to, value, data, operation, txGasEstimate, dataGasEstimate, gasPrice, txGasToken, executor, meta)
        //     assert.equal(subHash, events.args.subHash)
        // }
    }

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
        // console.log(createAndAddModulesData);
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

    it('should deposit 1.1 ETH and pay a daily 0.5 ETH subscription on two different days', async () => {
        // Deposit 1 ETH + some spare money for execution
        assert.equal(await web3.eth.getBalance(gnosisSafe.address), 0)
        await web3.eth.sendTransaction({from: receiver, to: gnosisSafe.address, value: web3.toWei(1.1, 'ether')})
        assert.equal(await web3.eth.getBalance(gnosisSafe.address).toNumber(), web3.toWei(1.1, 'ether'))

        let executorBalance = await web3.eth.getBalance(executor).toNumber()
        let recieverBalance = await web3.eth.getBalance(receiver).toNumber()
        let confirmingAccounts = [accounts[0], accounts[2]]


        // Withdraw 0.5 ETH
        let tx = await executeSubscriptionWithSigner(signer, 'executeSubscription withdraw 0.5 ETH', confirmingAccounts, receiver, web3.toWei(0.5, 'ether'), "0x", CALL, executor, {meta: await groundhogModule.contract.getSubscriptionMetaBytes(1, 1, 0)})


        console.log(`    Paying Daily Subscription Tx 0.5 ETH: ${tx}`);

        let safeBalanceAfter = await web3.eth.getBalance(gnosisSafe.address).toNumber();
        console.log(`    Balance After: ${safeBalanceAfter}`);
        let executorDiff = await web3.eth.getBalance(executor) - executorBalance
        executorBalance = await web3.eth.getBalance(executor);
        console.log("    Executor earned " + web3.fromWei(executorDiff, 'ether') + " ETH");

        console.log(`    Advancing Time 86400 seconds (1 Day)`);
        await timeHelper.advanceTimeAndBlock(86400);

        let tx2 = await executeSubscriptionWithSigner(signer, 'executeSubscription withdraw 0.5 ETH', confirmingAccounts, receiver, web3.toWei(0.5, 'ether'), "0x", CALL, executor, {meta: await groundhogModule.contract.getSubscriptionMetaBytes(1, 1, 0)})

        console.log(`    Paying Daily Subscription Tx 0.5 ETH: ${tx2}`);
        safeBalanceAfter = await web3.eth.getBalance(gnosisSafe.address).toNumber();
        console.log(`    After: ${safeBalanceAfter}`);
        executorDiff = await web3.eth.getBalance(executor) - executorBalance;

        let receiverDiff = await web3.eth.getBalance(receiver) - recieverBalance
        console.log("    Executor earned " + web3.fromWei(executorDiff, 'ether') + " ETH");

        assert.equal(receiverDiff, web3.toWei(1, 'ether'))
    });

    it('should deposit 1.1 ETH attempt to pay the same 0.5 subscription twice in the same day', async () => {
        // Deposit 1 ETH + some spare money for execution
        assert.equal(await web3.eth.getBalance(gnosisSafe.address), 0)
        await web3.eth.sendTransaction({from: receiver, to: gnosisSafe.address, value: web3.toWei(1.1, 'ether')})
        assert.equal(await web3.eth.getBalance(gnosisSafe.address).toNumber(), web3.toWei(1.1, 'ether'))

        let executorBalance = await web3.eth.getBalance(executor).toNumber()
        let recieverBalance = await web3.eth.getBalance(receiver).toNumber()
        let confirmingAccounts = [accounts[0], accounts[2]]


        // Withdraw 0.5 ETH
        let tx = await executeSubscriptionWithSigner(signer, 'executeSubscription withdraw 0.5 ETH', confirmingAccounts, receiver, web3.toWei(0.5, 'ether'), "0x", CALL, executor, {meta: await groundhogModule.contract.getSubscriptionMetaBytes(1, 1, 0)})


        console.log(`    Paying Daily Subscription Tx 0.5 ETH: ${tx}`);

        let safeBalanceAfter = await web3.eth.getBalance(gnosisSafe.address).toNumber();
        console.log(`    Balance After: ${safeBalanceAfter}`);

        console.log(`    Requesting Another Payment Immediately`);

        await utils.assertRejects(
            executeSubscriptionWithSigner(signer, 'executeSubscription withdraw 0.5 ETH', confirmingAccounts, receiver, web3.toWei(0.5, 'ether'), "0x", CALL, executor, {fails: true, meta: await groundhogModule.contract.getSubscriptionMetaBytes(1, 1, 0)}),
            "Withdraw Cooldown"
        )


        // console.log(`    Paying Daily Subscription Tx 0.5 ETH: ${tx2}`);
        safeBalanceAfter = await web3.eth.getBalance(gnosisSafe.address).toNumber();
        console.log(`    After: ${safeBalanceAfter}`);
        let executorDiff = await web3.eth.getBalance(executor) - executorBalance
        let receiverDiff = await web3.eth.getBalance(receiver) - recieverBalance

        console.log("    Executor earned " + web3.fromWei(executorDiff, 'ether') + " ETH");

        assert.equal(receiverDiff, web3.toWei(0.5, 'ether'));

    });
})
