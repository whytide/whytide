// The fake's one contractSuite call (../../../README.md "The contract suite").
import { contractSuite } from "../../../testing/index.ts";
import { filesCases } from "../../contract.ts";
import { filesPort } from "../../port.ts";
import { filesFakeAdapter } from "../index.ts";

contractSuite(filesPort, filesFakeAdapter, filesCases);
