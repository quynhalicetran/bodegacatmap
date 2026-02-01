import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";

export class BodegaCatMapStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------
    // 1) S3 Buckets (private)
    // ---------------------------
    const webBucket = new s3.Bucket(this, "WebBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    const imagesBucket = new s3.Bucket(this, "ImagesBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          // Needed later for browser direct uploads with presigned URLs
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.HEAD,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST
          ],
          allowedOrigins: ["*"], // tighten to your domain later
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"]
        }
      ],
      lifecycleRules: [
        {
          // Auto-clean junk uploads for unapproved cats
          prefix: "pending/",
          expiration: cdk.Duration.days(14)
        }
      ]
    });

    // ---------------------------
    // 2) CloudFront Distributions
    // ---------------------------
    // Using Origin Access Identity (OAI) for compatibility + simplicity.
    // If you want Origin Access Control (OAC) later, we can swap it safely.
    const oai = new cloudfront.OriginAccessIdentity(this, "OAI");

    const webDist = new cloudfront.Distribution(this, "WebDistribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: new origins.S3Origin(webBucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED
      },
      errorResponses: [
        // SPA-friendly: route 403/404 back to index.html
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: cdk.Duration.seconds(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: cdk.Duration.seconds(0) }
      ]
    });

    const imagesDist = new cloudfront.Distribution(this, "ImagesDistribution", {
      defaultBehavior: {
        origin: new origins.S3Origin(imagesBucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED
      }
    });

    // Upload a placeholder website so your CloudFront URL works immediately
    new s3deploy.BucketDeployment(this, "WebPlaceholderDeploy", {
      destinationBucket: webBucket,
      sources: [s3deploy.Source.asset("assets/web-placeholder")],
      distribution: webDist,
      distributionPaths: ["/*"]
    });

    // ---------------------------
    // 3) DynamoDB Tables
    // ---------------------------

    // Cats table
    const catsTable = new dynamodb.Table(this, "CatsTable", {
      partitionKey: { name: "catId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Query by status + geohash for map
    catsTable.addGlobalSecondaryIndex({
      indexName: "GSI_StatusGeohash",
      partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "geohash", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Admin pending queue
    catsTable.addGlobalSecondaryIndex({
      indexName: "GSI_StatusCreatedAt",
      partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // UserVisits (unique visits)
    const userVisitsTable = new dynamodb.Table(this, "UserVisitsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING }, // USER#id or ANON#id
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },     // CAT#catId
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // UserStats (leaderboard counts)
    const userStatsTable = new dynamodb.Table(this, "UserStatsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING }, // USER#id
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },      // SCOPE#NYC etc
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Leaderboard GSI: query top by scope
    userStatsTable.addGlobalSecondaryIndex({
      indexName: "GSI_Leaderboard",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING }, // SCOPE#NYC
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },      // 0000000042#USER#id
      projectionType: dynamodb.ProjectionType.ALL
    });

    // CatTreats (1 treat per visitor per cat)
    const catTreatsTable = new dynamodb.Table(this, "CatTreatsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING }, // CAT#catId
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },      // VISITOR#id
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // CatComments
    const catCommentsTable = new dynamodb.Table(this, "CatCommentsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING }, // CAT#catId
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },      // COMMENT#timestamp#visitor
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // VisitTokens (TTL)
    const visitTokensTable = new dynamodb.Table(this, "VisitTokensTable", {
      partitionKey: { name: "token", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "expiresAt" // epoch seconds
    });

    // ---------------------------
    // 4) Cognito (auth)
    // ---------------------------
    const userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: false
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const userPoolClient = userPool.addClient("WebClient", {
      authFlows: {
        userSrp: true,
        userPassword: true
      }
    });

    // Admin group (you will add your user to this later)
    new cognito.CfnUserPoolGroup(this, "AdminGroup", {
      groupName: "admin",
      userPoolId: userPool.userPoolId
    });

    // ---------------------------
    // 5) Lambda API (placeholder)
    // ---------------------------
    const apiFn = new lambda.Function(this, "ApiFunction", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          return {
            statusCode: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ok: true,
              message: "Bodega Cat Map API is deployed (placeholder).",
              path: event.rawPath || event.path,
              method: event.requestContext?.http?.method
            })
          };
        };
      `),
      environment: {
        CATS_TABLE: catsTable.tableName,
        USER_VISITS_TABLE: userVisitsTable.tableName,
        USER_STATS_TABLE: userStatsTable.tableName,
        CAT_TREATS_TABLE: catTreatsTable.tableName,
        CAT_COMMENTS_TABLE: catCommentsTable.tableName,
        VISIT_TOKENS_TABLE: visitTokensTable.tableName,
        IMAGES_CDN_BASE: `https://${imagesDist.distributionDomainName}`
      },
      memorySize: 512,
      timeout: cdk.Duration.seconds(10)
    });

    catsTable.grantReadWriteData(apiFn);
    userVisitsTable.grantReadWriteData(apiFn);
    userStatsTable.grantReadWriteData(apiFn);
    catTreatsTable.grantReadWriteData(apiFn);
    catCommentsTable.grantReadWriteData(apiFn);
    visitTokensTable.grantReadWriteData(apiFn);
    imagesBucket.grantReadWrite(apiFn);

    // ---------------------------
    // 6) API Gateway HTTP API
    // ---------------------------
    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      corsPreflight: {
        allowHeaders: ["*"],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowOrigins: ["*"] // tighten later to your CloudFront domain + localhost
      }
    });

    const lambdaIntegration = new integrations.HttpLambdaIntegration(
      "ApiIntegration",
      apiFn
    );

    // One catch-all route for now. Step 4 will implement real routing.
    httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration
    });
    httpApi.addRoutes({
      path: "/",
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration
    });

    // ---------------------------
    // 7) Outputs (you will paste into web env later)
    // ---------------------------
    new cdk.CfnOutput(this, "WebUrl", {
      value: `https://${webDist.distributionDomainName}`
    });

    new cdk.CfnOutput(this, "ImagesCdnBase", {
      value: `https://${imagesDist.distributionDomainName}`
    });

    new cdk.CfnOutput(this, "ApiUrl", {
      value: httpApi.apiEndpoint
    });

    new cdk.CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId
    });

    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId
    });

    new cdk.CfnOutput(this, "CatsTableName", { value: catsTable.tableName });
    new cdk.CfnOutput(this, "UserVisitsTableName", { value: userVisitsTable.tableName });
    new cdk.CfnOutput(this, "UserStatsTableName", { value: userStatsTable.tableName });
    new cdk.CfnOutput(this, "CatTreatsTableName", { value: catTreatsTable.tableName });
    new cdk.CfnOutput(this, "CatCommentsTableName", { value: catCommentsTable.tableName });
    new cdk.CfnOutput(this, "VisitTokensTableName", { value: visitTokensTable.tableName });
  }
}