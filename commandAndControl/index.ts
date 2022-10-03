const org = "pulumi";
const stack = "dev";
const backendURL = "https://api.pulumi.com/api"

type SupportedProject = "simple-resource" | "bucket-time" | "go-bucket" | "lambda-template";
type Operation = "update" | "preview" | "destroy" | "refresh";

const makePulumiAPICall = async (method: string, urlSuffix: string, payload?: any) => {
    const url = `${backendURL}/${urlSuffix}`
    const accessToken = process.env.PULUMI_ACCESS_TOKEN;
    const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `token ${accessToken}`
    };
    const response = await fetch(url, {
        method,
        headers,
        body: payload ? JSON.stringify(payload) : undefined
    });

    // An HTTP 409 means the Deployment logs aren't available yet. We'll retry.
    if (response.status === 409) {
        return
    }

    if(!response.ok) {
        let errMessage = "";
        try {
            errMessage = await response.text();
        } catch{}
        throw new Error(`failed to call ${urlSuffix}: ${errMessage}`)
    }

    return await response.json();
}

const createDeployment = async (project: string, payload: any) => {
    const urlSuffix  = `preview/${org}/${project}/${stack}/deployments`;

    return await makePulumiAPICall('POST', urlSuffix, payload);
}

const createSimpleDeployment = async (op: Operation) => {
    const payload = {
        sourceContext: {
            git: {
                repoURL: "https://github.com/pulumi/deploy-demos.git",
                branch: "refs/heads/main",
                repoDir: "simple-resource",
                gitAuth: {
                    accessToken: process.env.GITHUB_ACCESS_TOKEN,
                }
            }
        },
        operationContext: {
            operation: op,
            preRunCommands: [
            ],
            environmentVariables: {
            }
        }
    };

    return createDeployment("simple-resource", payload);
}

const createAwsBucketDeployment = async (op: Operation) => {
    const payload = {
        sourceContext: {
            git: {
                repoURL: "https://github.com/pulumi/deploy-demos.git",
                branch: "refs/heads/main",
                repoDir: "bucket-time",
                gitAuth: {
                    accessToken: process.env.GITHUB_ACCESS_TOKEN,
                }
            }
        },
        operationContext: {
            operation: op,
            preRunCommands: [
            ],
            environmentVariables: {
                AWS_REGION: "us-west-2",
                AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
                AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
                AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
            }
        }
    };

    return createDeployment("bucket-time", payload);
}

const createLambdaTemplateDeployment = async (op: Operation) => {
    const helloWorldHandler = `
    exports.handler =  async function(event, context) {
        console.log("EVENT:    " + JSON.stringify(event, null, 2))
        return context.logStreamName
    }
    `;
    const payload = {
        sourceContext: {
            git: {
                repoURL: "https://github.com/pulumi/deploy-demos.git",
                branch: "refs/heads/main",
                repoDir: "lambda-template",
                gitAuth: {
                    accessToken: process.env.GITHUB_ACCESS_TOKEN,
                }
            }
        },
        operationContext: {
            operation: op,
            preRunCommands: [
            ],
            environmentVariables: {
                AWS_REGION: "us-west-2",
                AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
                AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
                AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
                LAMBDA_CODE: helloWorldHandler,
            }
        }
    };

    return createDeployment("lambda-template", payload);
}

const createAwsGoBucketDeployment = async (op: Operation) => {
    const payload = {
        sourceContext: {
            git: {
                repoURL: "https://github.com/pulumi/deploy-demos.git",
                branch: "refs/heads/main",
                repoDir: "go-bucket",
                gitAuth: {
                    accessToken: process.env.GITHUB_ACCESS_TOKEN,
                }
            }
        },
        operationContext: {
            operation: op,
            preRunCommands: [],
            environmentVariables: {
                AWS_REGION: "us-west-2",
                AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
                AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
                AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
            }
        }
    };

    return createDeployment("go-bucket", payload);
}

const createProjectDeployment = async (project: SupportedProject, op: Operation = "update") => {
    switch(project) {
        case "simple-resource":
            return createSimpleDeployment(op);
        case "bucket-time":
            return createAwsBucketDeployment(op);
        case "go-bucket":
            return createAwsGoBucketDeployment(op);
        case "lambda-template":
            return createLambdaTemplateDeployment(op);
        default:
            throw new Error(`unable to deploy project. unknown project: ${project}`);
    }
}

const getDeploymentStatus = async (deployment: DeploymentAction) => {

   return await makePulumiAPICall("GET", `preview/${org}/${deployment.project}/${stack}/deployments/${deployment.id}`)
}

// Gets logs for a Deployment by Job. Each step in the process is unknown to the caller,
// and can only operate on the continuation token informing of the next action to take.
//
// The continuation token is a string that represents the step:offset in the logs to request.
const getDeploymentLogsByJob = async (deployment: DeploymentAction) => {
    let hasMoreLogs = true;
    const logs: string[] = [];

    while (hasMoreLogs) {
        const {currentJob, continuationToken} = deployment.logMarker!;
        let query = `job=${currentJob}`;

        if (continuationToken !== undefined) {
            query+= `&continuationToken=${continuationToken}`;
        }

        const logsResponse = await makePulumiAPICall("GET", `preview/${org}/${deployment.project}/${stack}/deployments/${deployment.id}/logs?${query}`);
        const logLines = (logsResponse.lines || []).map((l: any) => `${l.timestamp}: ${l.line}`);

        // If this is the first request, add the step name to the logs.
        if (continuationToken === undefined) {
            logs.push('--- Step: ' + logsResponse.name + '\n')
        }

        if (logsResponse.continuationToken !== undefined) {
            let splitToken = logsResponse.continuationToken.split(":");
             // If this is the first request for a new step, add a header.
            if  (splitToken[1] === '0' && logLines.length > 0) {
                logs.push('--- Step: ' + logsResponse.name + '\n')
            }
            deployment.logMarker!.continuationToken = logsResponse.continuationToken;
        } else {
            hasMoreLogs = false;
        }
        logs.push(...logLines);
    }
    return logs;
}

// Gets logs for a Deployment by Step.
// Logs are requested by step and offset. Each step result returns a nextOffset
// informing the caller of the next offset to request and that there are more logs
// to be retrieved.
//
// If the nextOffset is undefined, then no more logs are available for the step.
const getDeploymentLogsByStep = async (deployment: DeploymentAction) => {
    const logs: string[] = [];

    // Loop through all the steps in the Job starting at step00, offset=0.
    // While the offset is defined, we have more logs to fetch. When the offset===undefined,
    // no more logs are available for that step.
    //
    // Iterate to the next step and repeat until all steps have been fetched.
    for (let i = 0; i < deployment.steps!.length; i++) {
        const step = deployment.steps![i];
        logs.push('--- Step: ' + step.name + '\n')

        let offset = 0;
        while(offset !== undefined) {
            const query = `job=0&step=${i}&offset=${offset}`;
            const logsResponse = await makePulumiAPICall("GET", `preview/${org}/${deployment.project}/${stack}/deployments/${deployment.id}/logs?${query}`);
            const logLines = (logsResponse.lines || []).map((l: any) => `${l.timestamp}: ${l.line}`);
            logs.push(...logLines);

            offset = logsResponse.nextOffset;
        }
    }

    return logs;
 }

function delay(ms: number) {
    return new Promise( resolve => setTimeout(resolve, ms) );
}

const printStatusAndLogs = async (deployment: DeploymentAction) =>{
    const deploymentStatusResult = await getDeploymentStatus(deployment);

    const deploymentLogs = await getDeploymentLogsByJob(deployment);
    const logs = deploymentLogs.join('');

    console.log(deploymentStatusResult);
    console.log(logs);
}

const nonTerminalDeploymentStatuses = ["not-started", "accepted", "running"];

const isDeploymentRunning = (status: string) => {
    return (nonTerminalDeploymentStatuses.includes(status) || !status);
}

type DeploymentAction = {
    project: SupportedProject;
    op: Operation;
    id?: string;
    status?: string;
    steps?: DeploymentStep[];
    logMarker?: DeploymentLogMarker;
};

type DeploymentLogMarker = {
    nextOffset?: number;
    currentStep?: number;
    currentJob?: number; // always 1 in current impl
    totalSteps?: number;
    totalJobs?: number; // always 1 in current impl
    continuationToken?: string;
}

type DeploymentStep = {
    name: string;
}

const queryDeployment = async (deployment: DeploymentAction) => {
    if(!deployment.logMarker) {
        deployment.logMarker = {
            nextOffset: 0,
            currentJob: 0, // always 1 in current impl
            currentStep: 0,
            totalJobs: 1,
        };
    }

    const deploymentStatusResult = await getDeploymentStatus(deployment);
        deployment.status = deploymentStatusResult.status;

        // we only have enough state about the deployment to query for logs once it reaches "running" state
        // https://github.com/pulumi/pulumi-service/issues/10266
        if (deployment.status !== "not-started" && deployment.status !== "accepted") {
            deployment.logMarker.totalSteps = deploymentStatusResult.jobs[0].steps.length;
            deployment.steps = deploymentStatusResult.jobs[0].steps;

            // const deploymentLogs = await getDeploymentLogsByJob(deployment); (Blocked on https://github.com/pulumi/pulumi-service/pull/10276)
            const deploymentLogs = await getDeploymentLogsByStep(deployment);
            const logs = deploymentLogs.join('');
            if (logs) {
                console.log(deploymentStatusResult);
                console.log(logs);
            }
        } else {
            console.log(deploymentStatusResult);
        }

    return !isDeploymentRunning(deployment.status!);
}

const monitorDeployments = async (deployments: DeploymentAction[]) => {
    
    let deploymentIDs = deployments.map(d => d.id!);

    while(deploymentIDs.length) {
        let completedDeployments: string[]= [];
        for(let deploymentID of deploymentIDs) {
            let deployment = deployments.find( d => (d.id!) === deploymentID);
            if(await queryDeployment(deployment!)){
                completedDeployments.push(deploymentID);
            }
        }
        // filter out completed deployments for the next pass
        deploymentIDs = deploymentIDs.filter(x => completedDeployments.indexOf(x) === -1);
        console.log(`Finished polling deployments: ${completedDeployments.length} out of ${deploymentIDs.length} complete.`);
        await delay(2000);
    }
};

const execDeployments = async (deployments: DeploymentAction[]) => {
    let deploymentNumber = 1;
    for(let deployment of deployments) {
        console.log(`executing deployment ${deploymentNumber}`)
        const deploymentResult = await createProjectDeployment(deployment.project, deployment.op);
        console.log(deploymentResult);
        deployment.id = deploymentResult.id;
        deploymentNumber++;
    }

    return deployments;
}

const execDeploymentsAndMonitorToCompletion = async (deployments: DeploymentAction[]) => {
    deployments = await execDeployments(deployments);
    await monitorDeployments(deployments);

    console.log(JSON.stringify(deployments, null, 2));
    return deployments;
};

const run = async () => {

    // run a single supported project

    // // const project: SupportedProject = "go-bucket";
    // const project: SupportedProject = "simple-resource";
    // // const project: SupportedProject = "bucket-time";
    // const op: Operation = "update";
    // const deployments: DeploymentAction[] = [{
    //     project,
    //     op,
    // }];
    

    // parallel load test variant targeting the same stack

    // const deployments: DeploymentAction[] = [];
    // for (let i = 0; i < 9; i++) {
    //     deployments.push({
    //         project: "bucket-time",
    //         op: "update",
    //     });
    // }


     // lambda deployment - specify a function as a string (environment variable) and deploy it
    //  const deployments: DeploymentAction[] = [
    //     {
    //         project: "lambda-template",
    //         op: "update",
    //     },
    // ];


    // deploy all three sample programs simultaneously
    const deployments: DeploymentAction[] = [
        // {
        //     project: "bucket-time",
        //     op: "update",
        // },
        // {
        //     project: "simple-resource",
        //     op: "update",
        // },
        {
            project: "go-bucket",
            op: "update",
        },
    ];

    await execDeploymentsAndMonitorToCompletion(deployments);

    // useful for debugging the driver if it happens to exit early before a deployment has finished (ie an API field changes)
    // printStatusAndLogs("79fcd545-f9f0-4287-8c53-06072f508732")

}
run().catch(err => console.log(err));
