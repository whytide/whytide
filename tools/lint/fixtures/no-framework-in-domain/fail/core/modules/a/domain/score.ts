import { Agent } from "@mastra/core";
import { Injectable } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { proxyActivities } from "@temporalio/workflow";
import { headers } from "next";
export const score = [Injectable, Agent, PrismaClient, proxyActivities, headers];
