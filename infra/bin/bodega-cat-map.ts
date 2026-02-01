#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { BodegaCatMapStack } from "../lib/bodega-cat-map-stack";

const app = new cdk.App();

new BodegaCatMapStack(app, "BodegaCatMapStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  }
});