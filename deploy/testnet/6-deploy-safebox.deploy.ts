import fs from 'fs';
import { ethers, network, upgrades } from "hardhat";
import { ADDRESS_GOERLI, CONTRACT_NAMES } from "../../constant";
import { SafeBox } from "../../typechain-types";

const deploymentPath = "./deployments";
const deploymentFilePath = `${deploymentPath}/${network.name}.json`;

function writeDeployments(deployment: any) {
	if (!fs.existsSync(deploymentPath)) {
		fs.mkdirSync(deploymentPath);
	}
	fs.writeFileSync(deploymentFilePath, JSON.stringify(deployment, null, 2));
}

async function main(): Promise<void> {
	const deployment = fs.existsSync(deploymentFilePath)
		? JSON.parse(fs.readFileSync(deploymentFilePath).toString())
		: {};

	const [deployer] = await ethers.getSigners();
	console.log("Deployer:", deployer.address);

	// SafeBox
	const SafeBox = await ethers.getContractFactory(CONTRACT_NAMES.SafeBox);
	const safeBox = <SafeBox>await upgrades.deployProxy(SafeBox, [
		ADDRESS_GOERLI.bICHI,
		"Interest Bearing ICHI",
		"ibICHI"
	]);
	await safeBox.deployed();
	console.log('SafeBox-ICHI:', safeBox.address);
	deployment.ICHI_SafeBox = safeBox.address;
	writeDeployments(deployment);

	await safeBox.setBank(deployment.BlueBerryBank);

	const bank = await ethers.getContractAt("BlueBerryBank", deployment.BlueBerryBank);
	// Add Bank
	await bank.whitelistTokens([deployment.MockIchiV2], [true])
	await bank.addBank(
		deployment.MockIchiV2,
		ADDRESS_GOERLI.bICHI,
		deployment.ICHI_SafeBox
	)
}

main()
	.then(() => process.exit(0))
	.catch((error: Error) => {
		console.error(error);
		process.exit(1);
	});
