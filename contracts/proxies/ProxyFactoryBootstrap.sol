pragma solidity 0.4.24;

/// @title Proxy - Generic proxy contract allows to execute all transactions applying the code of a master contract.
/// @author Stefan George - <stefan@gnosis.pm>
contract Proxy {

    // masterCopy always needs to be first declared variable, to ensure that it is at the same location in the contracts to which calls are delegated.
    address masterCopy;

    /// @dev Constructor function sets address of master copy contract.
    /// @param _masterCopy Master copy address.
    constructor(address _masterCopy)
    public
    {
        require(_masterCopy != 0, "Invalid master copy address provided");
        masterCopy = _masterCopy;
    }

    /// @dev Fallback function forwards all transactions and returns all received return data.
    function ()
    external
    payable
    {
        // solium-disable-next-line security/no-inline-assembly
        assembly {
            let masterCopy := and(sload(0), 0xffffffffffffffffffffffffffffffffffffffff)
            calldatacopy(0, 0, calldatasize())
            let success := delegatecall(gas, masterCopy, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if eq(success, 0) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    function implementation()
    public
    view
    returns (address)
    {
        return masterCopy;
    }

    function proxyType()
    public
    pure
    returns (uint256)
    {
        return 2;
    }
}


/// @title SecuredTokenTransfer - Secure token transfer
/// @author Richard Meissner - <richard@gnosis.pm>
contract SecuredTokenTransfer {

    /// @dev Transfers a token and returns if it was a success
    /// @param token Token that should be transferred
    /// @param receiver Receiver to whom the token should be transferred
    /// @param amount The amount of tokens that should be transferred
    function transferToken (
        address token,
        address receiver,
        uint256 amount
    )
    internal
    returns (bool transferred)
    {
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", receiver, amount);
        // solium-disable-next-line security/no-inline-assembly
        assembly {
            let success := call(sub(gas, 10000), token, 0, add(data, 0x20), mload(data), 0, 0)
            let ptr := mload(0x40)
            returndatacopy(ptr, 0, returndatasize)
            switch returndatasize
            case 0 { transferred := success }
            case 0x20 { transferred := iszero(or(iszero(success), iszero(mload(ptr)))) }
            default { transferred := 0 }
        }
    }
}


contract PayingProxy is Proxy, SecuredTokenTransfer {

    /// @dev Constructor function sets address of master copy contract.
    /// @param _masterCopy Master copy address.
    /// @param funder Address that should be paid for the execution of this call
    /// @param paymentToken Token that should be used for the payment (0 is ETH)
    /// @param payment Value that should be paid
    constructor(address _masterCopy, address funder, address paymentToken, uint256 payment)
    Proxy(_masterCopy)
    public
    {
        if (payment > 0) {
            if (paymentToken == address(0)) {
                // solium-disable-next-line security/no-send
                require(funder.send(payment), "Could not pay safe creation with ether");
            } else {
                require(transferToken(paymentToken, funder, payment), "Could not pay safe creation with token");
            }
        }
    }
}


/// @title Counter-factual PayingProxy Bootstrap contract
/// A PayingProxy that can also be bootstrapped immediately following creation in one txn
/// A random deployer account is created, this contract is nonce 0 from the transaction that creates the safe
/// Using this Counter-factual address, a second address is generated, this is the safe address
/// the user funds this address, and then this contract is deployed to bootstrap the safe and module creation
/// @author Andrew Redden - <andrew@groundhog.network>
contract PayingProxyBootstrap {

    event ProxyCreation(PayingProxy proxy);
    /// @dev Allows to create new proxy contact and execute a message call to the new proxy within one transaction.
    /// @param masterCopy Address of master copy.
    /// @param data Payload for message call sent to new proxy contract.
    /// @param funder Address of the funder
    /// @param paymentToken address of the token to repay deployment
    /// @param payment Value of the paymentToken to be paid for deployment
    constructor (address masterCopy, bytes data, address funder, address paymentToken, uint256 payment)
    public
    {
        PayingProxy proxy = new PayingProxy(masterCopy, funder, paymentToken, payment);

        if (data.length > 0)
        // solium-disable-next-line security/no-inline-assembly
            assembly {
                if eq(call(gas, proxy, 0, add(data, 0x20), mload(data), 0, 0), 0) { revert(0, 0) }
            }
        emit ProxyCreation(proxy);

        // no sense bloating chain with a bootstrap contract, make sure you selfdestruct
        selfdestruct(funder);
    }
}
